#!/usr/bin/env node
// addon.a2a-bridge local-service entry (http-json on 127.0.0.1:4898).
//
// FLAGSHIP GIFT B — serves the browser-first 2.0.0-alpha opencode delegation
// as an A2A 0.2.5 JSON-RPC server on loopback. SERVE-ONLY: the bridge never
// dials beyond 127.0.0.1 (its own bind) and one upstream host — the existing
// browser-first bridge at 127.0.0.1:47773 — using tokens the OPERATOR
// supplies. External send remains the delegation packet's human-approval
// gated deniedCapability (forbiddenActions: external-send); the bridge adds
// no capability tokens and no new surface beyond the loopback bind.
//
// A0 (build-gate, verified): their SDK has NO add-on token-injection path
// (no spawn/env logic anywhere in src/sdk/addons/). The bridge therefore
// reads OPERATOR-PROVIDED tokens from its environment — the exact env names
// the browser-first launcher mints (host bridge-capability-tokens.mjs:42-45,
// bridge token run-bridge-minimal.mjs:368) — and FAILS LOUD at startup with
// setup instructions if any is missing. Token values are never logged.
//
// Async-start reality (Architect change 1, Critic R1): the host's
// /opencode/delegation/start runs the delegation to completion INSIDE the
// call (addon-delegation-service.mjs:1529-1638). The bridge fires start
// WITHOUT awaiting it (background fetch, .catch logged, response abandoned)
// and returns A2A "submitted" immediately; the lifecycle is driven by
// tasks/get polling (running state is observable on disk mid-run, :1540).
// A submitted-deadline bounds the window before the first "running" is
// observed. CANCEL LATCH (Architect change 2): once tasks/cancel is issued
// the local task is terminal-canceled; later host writes (their
// cancel-overwrite race, :1620 vs :1677) can never flip it back.
//
// Privacy: externally a task is an opaque bridge-minted taskId. Host
// status/artifact responses carry home-relative path/resultArtifactPath and
// 360-char mission/context/result excerpts (:517-534) — the bridge reads
// ONLY the fields it needs (status, blockedReason, artifact content) and
// never exposes, logs, or persists paths or excerpts. Artifacts are returned
// verbatim, never mutated, never persisted. Every outbound body and every
// log line passes through home-path redaction as defense in depth.
//
// Framing mirrors the epoch/stack-bench siblings: body 1..262144 bytes
// (bridge-own cap), oversized -> 413 + close, lying Content-Length -> 408
// (explicit body-receipt deadline) + close, chunked -> 400, bind conflict ->
// exit 78, wider-than-loopback bind refused (fail loud).

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADDON_ID = "addon.a2a-bridge";
const ADDON_VERSION = "0.1.0";
const A2A_VERSION = "0.2.5";

// -- A0: operator-provided capability tokens (fail loud at startup) ----------

// The exact env names their launcher mints, cited verbatim from
// repos/2.0.0-alpha/browser-first/host/bridge-capability-tokens.mjs:42-45
// and run-bridge-minimal.mjs:368. Do not rename.
const REQUIRED_TOKEN_ENVS = Object.freeze([
  {
    env: "RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN",
    capability: "bridge authentication (every host request)",
  },
  {
    env: "RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN",
    capability: "addon-record-write (POST /addons/delegate)",
  },
  {
    env: "RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN",
    capability: "addon-runtime-control (delegation start + cancel)",
  },
  {
    env: "RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN",
    capability: "addon-runtime-read (delegation status + artifact)",
  },
]);

function checkRequiredEnv(env = process.env) {
  const missing = REQUIRED_TOKEN_ENVS.filter(({ env: name }) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
  return { ok: missing.length === 0, missing };
}

function setupInstructions(missing) {
  return [
    "a2a-bridge: refusing to start — operator-provided capability tokens are missing.",
    "",
    "Their browser-first SDK has no add-on token-injection path, so this bridge reads",
    "the tokens the browser-first launcher already minted from its own environment.",
    "Set every variable below to the matching launcher-minted token value, then restart:",
    "",
    ...missing.map(({ env, capability }) => `  ${env}   # ${capability}`),
    "",
    "The values live with the browser-first bridge launcher that minted them",
    "(RESONANTOS_BROWSER_FIRST_* tokens). They are read once at startup and are",
    "never logged, echoed, or persisted by this bridge.",
  ].join("\n");
}

// -- bridge configuration -----------------------------------------------------

const PORT = parseDevPort(); // dev override only; the manifest entrypoint (4898) is the contract
const HOST_BASE_URL = parseDevTargetUrl();
const REQUEST_TIMEOUT_MS = parseDevTimeout(); // lying-Content-Length body deadline
const HOST_TIMEOUT_MS = 60000; // one attempt per host call; the bridge never retries

const MAX_BODY = 256 * 1024; // bridge-own protective body cap (documented choice)
const MISSION_MIN = 8; // THEIR invariant (addon-delegation-service.mjs:281-283)
const MISSION_MAX = 24_000; // bridge-own protective mission cap (their 24k cap is on contextMarkdown, :275)
const MAX_TASKS = 64; // bounded task table; oldest evicted (documented -32001)
const RATE_MAX = 6; // bridge-own rolling-window rate limit, per hour
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = 1; // bridge-own: one delegation in flight
const SUBMITTED_DEADLINE_MS = parseDevSubmittedDeadline();

function parseDevPort() {
  const raw = process.env.A2A_BRIDGE_PORT;
  if (raw === undefined) return 4898;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    process.stderr.write("a2a-bridge: A2A_BRIDGE_PORT must be an integer in 1..65535\n");
    process.exit(78);
  }
  return n;
}

function parseDevTargetUrl() {
  const raw = process.env.A2A_BRIDGE_TARGET_URL;
  if (raw === undefined || raw.trim() === "") return "http://127.0.0.1:47773";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    const host = url.hostname;
    // Serve-only posture: the upstream must also be loopback. 127.0.0.1/::1/[::1] only.
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
      throw new Error("host");
    }
    return raw.replace(/\/+$/, "");
  } catch {
    process.stderr.write("a2a-bridge: A2A_BRIDGE_TARGET_URL must be a loopback http(s) URL\n");
    process.exit(78);
  }
}

function parseDevTimeout() {
  const raw = process.env.A2A_BRIDGE_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return 30000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 300000) {
    process.stderr.write("a2a-bridge: A2A_BRIDGE_REQUEST_TIMEOUT_MS must be an integer in 1000..300000\n");
    process.exit(78);
  }
  return n;
}

function parseDevSubmittedDeadline() {
  const raw = process.env.A2A_BRIDGE_SUBMITTED_DEADLINE_MS;
  if (raw === undefined) return 30000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 600000) {
    process.stderr.write("a2a-bridge: A2A_BRIDGE_SUBMITTED_DEADLINE_MS must be an integer in 1000..600000\n");
    process.exit(78);
  }
  return n;
}

// -- agent card (production-reference shape, bridge-own identity content) -----

// Shape pinned to the production reference (puenteworks agent-card.js:1-41):
// supportedInterfaces.protocolVersion inside the interfaces block, capabilities
// block, no invented top-level fields. Content is the BRIDGE'S OWN identity —
// never PuenteWorks' name, description, provider, skills, or URLs.
const AGENT_CARD = Object.freeze({
  name: "A2A Bridge (ResonantOS delegation)",
  description:
    "Exposes the local ResonantOS opencode delegation as an A2A 0.2.5 server on this machine's loopback. Any A2A client submits a text mission with message/send, polls tasks/get for the lifecycle (submitted, working, completed, failed, canceled), and retrieves the delegation's result artifact verbatim when it completes. Serve-only: the bridge accepts connections on 127.0.0.1 and forwards to the local ResonantOS browser-first bridge only; external actions remain governed by the delegation's own human-approval boundary.",
  supportedInterfaces: [
    {
      url: "http://127.0.0.1:4898/",
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_VERSION,
    },
  ],
  provider: {
    organization: "ResonantOS add-on (local operator)",
    url: "http://127.0.0.1:4898/",
  },
  version: ADDON_VERSION,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
  },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [
    {
      id: "delegate-mission-to-local-opencode",
      name: "Delegate a mission to the local opencode agent",
      description:
        "Accepts a plain-text mission (8 to 24000 characters) and runs it through the ResonantOS opencode delegation on this machine. The delegation runs under ResonantOS governance: no provider-secret access, no wallet actions, no trusted-memory writes, and no external sends (human approval required upstream). Returns an opaque task id immediately; poll with tasks/get until completed and read the verbatim result artifact.",
      tags: ["delegation", "local-agent", "opencode", "a2a", "coding-agent"],
      examples: [
        "Summarize the module at the repo root and list its public functions",
        "Draft a refactor plan for the parser module and report risks",
        "Explain what the failing test in this workspace covers",
      ],
    },
  ],
});

const CARD_BYTES = JSON.stringify(AGENT_CARD, null, 2);
const CARD_ETAG = `"${ADDON_ID}-card-${createHash("sha256").update(CARD_BYTES).digest("hex").slice(0, 16)}"`;

// -- JSON-RPC / A2A error vocabulary ------------------------------------------
// Envelope and codes verified verbatim in puenteworks-link-headers/src/index.js:
// -32700 Parse error -> HTTP 400 (:110); -32600 Invalid Request -> HTTP 400
// (:113); -32601 Method not found -> HTTP 200 (:117); -32602 params messages
// (:123, :128). Task-level codes per the vendored A2A SDK (a2a/types.py):
// -32001 Task not found, -32002 Task not cancelable.

const CODE_PARSE = -32700;
const CODE_INVALID_REQUEST = -32600;
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL = -32603;
const CODE_TASK_NOT_FOUND = -32001;
const CODE_TASK_NOT_CANCELABLE = -32002;

const METHODS = Object.freeze(["message/send", "tasks/get", "tasks/cancel"]);

// State map (PRD d): host status -> A2A state.
const STATE_MAP = Object.freeze({
  queued: "submitted",
  running: "working",
  completed: "completed",
  blocked: "failed",
  failed: "failed",
  cancelled: "canceled",
});

// -- helpers -------------------------------------------------------------------

function redact(text) {
  const home = os.homedir();
  return home && home !== "/" && home !== "~" ? String(text).split(home).join("~") : String(text);
}

function log(line) {
  process.stderr.write(`a2a-bridge: ${redact(line)}\n`);
}

function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // \t (0x09), \n (0x0a), \r (0x0d) are legitimate mission whitespace.
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function echoableId(id) {
  // Echo the request id only when it is a JSON scalar; anything else -> null
  // (the envelope must never reflect attacker-controlled structure).
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  return null;
}

// -- bridge core (transport-independent; HTTP layer wraps this) -----------------

export function createBridgeCore({
  env = process.env,
  now = () => Date.now(),
  uuid = randomUUID,
  fetchImpl = fetch,
  targetBaseUrl = HOST_BASE_URL,
  limits = {},
} = {}) {
  const missionMax = limits.missionMax ?? MISSION_MAX;
  const maxTasks = limits.maxTasks ?? MAX_TASKS;
  const rateMax = limits.rateMax ?? RATE_MAX;
  const rateWindowMs = limits.rateWindowMs ?? RATE_WINDOW_MS;
  const maxConcurrent = limits.maxConcurrent ?? MAX_CONCURRENT;
  const submittedDeadlineMs = limits.submittedDeadlineMs ?? SUBMITTED_DEADLINE_MS;

  const tokens = {
    bridge: String(env.RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN ?? ""),
    recordWrite: String(env.RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN ?? ""),
    runtimeControl: String(env.RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN ?? ""),
    runtimeRead: String(env.RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN ?? ""),
  };

  /** taskId -> task record. Insertion-ordered; capped at maxTasks. */
  const tasks = new Map();
  const rateWindow = []; // timestamps of accepted message/send calls

  function logEvent(line) {
    log(line);
  }

  // Normalize a Response (global fetch) or an injected {status, body} mock
  // (tests) into {status, ok, body}.
  async function readHostBody(res) {
    let body = null;
    if (typeof res.json === "function") {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } else {
      body = res.body ?? null;
    }
    const ok = typeof res.ok === "boolean" ? res.ok : res.status >= 200 && res.status < 300;
    return { status: res.status, ok, body };
  }

  // One host call. Single attempt — the bridge never retries (PRD A5).
  async function hostFetch(route, capabilityToken, payload) {
    const res = await fetchImpl(`${targetBaseUrl}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-resonantos-bridge-token": tokens.bridge,
        "x-resonantos-bridge-capability-token": capabilityToken,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    return readHostBody(res);
  }

  function taskView(task) {
    // A4b: state + artifactRef ONLY. No A2A history array, no host fields
    // (path, excerpts, updatedAt, ...) ever leave bridge memory.
    const view = {
      id: task.taskId,
      contextId: task.contextId,
      status: {
        state: task.state,
        timestamp: task.timestamp,
      },
    };
    if (task.state === "failed" && task.reason) {
      view.status.message = {
        role: "agent",
        parts: [{ kind: "text", text: task.reason }],
      };
    }
    if (task.state === "completed" && task.artifact !== undefined) {
      view.artifactRef = {
        name: "result.md",
        mimeType: "text/markdown",
        content: task.artifact, // verbatim; never mutated, never persisted
      };
    }
    return view;
  }

  function setTaskState(task, state, { reason } = {}) {
    task.state = state;
    task.timestamp = new Date(now()).toISOString();
    if (reason !== undefined) task.reason = reason;
    else if (state !== "failed") task.reason = undefined;
  }

  function isTerminal(state) {
    return state === "completed" || state === "failed" || state === "canceled";
  }

  function rpcResult(id, result) {
    return { httpStatus: 200, envelope: { jsonrpc: "2.0", id, result } };
  }

  function rpcError(id, code, message, { httpStatus = 200, data } = {}) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { httpStatus, envelope: { jsonrpc: "2.0", id, error } };
  }

  // -- message/send ------------------------------------------------------------

  function validateMission(params) {
    const keys = Object.keys(params);
    for (const key of keys) {
      if (key !== "message" && key !== "configuration" && key !== "metadata") {
        return { error: "Invalid params: params contain an unknown field" };
      }
    }
    const message = params.message;
    if (!isPlainObject(message) || !Array.isArray(message.parts) || message.parts.length === 0) {
      // Their wire message verbatim (index.js:123).
      return { error: "Invalid params: message.parts is required" };
    }
    const texts = message.parts.map((part) => {
      if (isPlainObject(part) && typeof part.text === "string") return part.text;
      if (isPlainObject(part) && isPlainObject(part.data)) {
        try {
          return JSON.stringify(part.data);
        } catch {
          return "";
        }
      }
      return "";
    });
    const mission = texts.filter(Boolean).join(" ");
    if (mission === "") {
      // Their wire message verbatim (index.js:128).
      return { error: "Invalid params: a text or data part is required" };
    }
    if (hasControlChars(mission)) {
      return { error: "Invalid params: mission contains control characters" };
    }
    if (mission.length < MISSION_MIN) {
      // Their 8-char minimum (addon-delegation-service.mjs:281-283).
      return { error: `Invalid params: mission must be at least ${MISSION_MIN} characters` };
    }
    if (mission.length > missionMax) {
      return { error: `Invalid params: mission must be at most ${missionMax} characters` };
    }
    return { mission };
  }

  // Fired, never awaited (Architect change 1 / Critic R1). The host runs the
  // delegation to completion inside this call; we abandon the response.
  function fireStart(task) {
    const startedAt = now();
    const finish = fetchImpl(`${targetBaseUrl}/opencode/delegation/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-resonantos-bridge-token": tokens.bridge,
        "x-resonantos-bridge-capability-token": tokens.runtimeControl,
      },
      body: JSON.stringify({ path: task.hostPath }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    finish
      .then(async (res) => {
        const { status, ok, body } = await readHostBody(res);
        if (ok) {
          logEvent(`start completed status=${status} task=terminal-pending elapsed=${now() - startedAt}ms`);
          return;
        }
        // Surface the two fixed auth failures verbatim in the log only; the
        // task itself stays whatever the poll observes (usually blocked).
        if (status === 401 || status === 403) {
          logEvent(`start auth failure status=${status} error=${redact(String(body?.error ?? "")).slice(0, 200)}`);
          return;
        }
        logEvent(`start failed status=${status}`);
      })
      .catch((err) => {
        logEvent(`start abandoned: ${err?.name === "TimeoutError" || err?.name === "AbortError" ? "host timeout" : "network error"}`);
      });
  }

  async function handleMessageSend(id, params) {
    // Bridge-own protective limits (documented choices): 1 concurrent, 6/hour
    // rolling window, single process. Counters reset on restart.
    const windowStart = now() - rateWindowMs;
    while (rateWindow.length > 0 && rateWindow[0] <= windowStart) rateWindow.shift();
    if (rateWindow.length >= rateMax) {
      const retryAfterSec = Math.max(1, Math.ceil((rateWindow[0] + rateWindowMs - now()) / 1000));
      return {
        httpStatus: 429,
        envelope: { jsonrpc: "2.0", id: echoableId(id), error: { code: CODE_INTERNAL, message: "rate limit exceeded: 6 missions per rolling hour" } },
        headers: { "Retry-After": String(retryAfterSec) },
      };
    }
    const active = [...tasks.values()].filter((t) => !isTerminal(t.state)).length;
    if (active >= maxConcurrent) {
      return {
        httpStatus: 429,
        envelope: { jsonrpc: "2.0", id: echoableId(id), error: { code: CODE_INTERNAL, message: "concurrency limit exceeded: one delegation at a time" } },
        headers: { "Retry-After": "1" },
      };
    }

    const check = validateMission(params);
    if (check.error) {
      return rpcError(id, CODE_INVALID_PARAMS, check.error);
    }
    const mission = check.mission;

    // Step 1: create the governed delegation packet (their markdown packet,
    // capability addon-record-write; addon-delegation-host-service.mjs:130-134).
    let record;
    try {
      const res = await hostFetch("/addons/delegate", tokens.recordWrite, {
        target: "opencode",
        mission,
        source: "a2a-bridge",
      });
      if (res.status === 401 || res.status === 403) {
        // A5: surface their 401/403 verbatim (fixed safe strings), no retry.
        // Length-capped: the body comes from the host, so never trust its size.
        return {
          httpStatus: res.status,
          envelope: {
            jsonrpc: "2.0",
            id: echoableId(id),
            error: {
              code: CODE_INTERNAL,
              message: String(res.body?.error ?? "upstream bridge request failed").slice(0, 200),
              data: { upstreamStatus: res.status },
            },
          },
        };
      }
      if (!res.ok) {
        logEvent(`delegate failed status=${res.status}`);
        return rpcError(id, CODE_INTERNAL, "upstream bridge request failed", { data: { upstreamStatus: res.status } });
      }
      record = res.body;
    } catch (err) {
      logEvent(`delegate unreachable: ${err?.name === "TimeoutError" || err?.name === "AbortError" ? "host timeout" : "network error"}`);
      return rpcError(id, CODE_INTERNAL, "upstream bridge request failed", { data: { upstreamStatus: 0 } });
    }

    // A9 drift: their record shape must carry a usable path. No guessing.
    if (!isPlainObject(record) || typeof record.path !== "string" || record.path === "") {
      logEvent("drift: delegate response missing path");
      return rpcError(id, CODE_INTERNAL, "upstream response shape drift");
    }

    // Step 2: register the task with an OPAQUE taskId; the host path stays in
    // bridge memory only (never exposed, logged, or persisted).
    const taskId = `tsk_${uuid()}`;
    const contextId = isPlainObject(params.message) && typeof params.message.contextId === "string" && params.message.contextId !== ""
      ? params.message.contextId
      : `ctx_${uuid()}`;
    const task = {
      taskId,
      contextId,
      hostPath: record.path,
      state: "submitted",
      timestamp: new Date(now()).toISOString(),
      createdAt: now(),
      artifact: undefined,
      reason: undefined,
    };
    tasks.set(taskId, task);
    while (tasks.size > maxTasks) {
      const oldest = tasks.keys().next().value;
      tasks.delete(oldest); // documented: evicted tasks read back as -32001
      logEvent("task table full: oldest task evicted");
    }
    rateWindow.push(now());

    // Step 3: fire start without awaiting (async-start reality).
    fireStart(task);

    return rpcResult(id, taskView(task));
  }

  // -- tasks/get (the poll that drives the lifecycle) ---------------------------

  async function pollHostStatus(task) {
    let res;
    try {
      res = await hostFetch("/opencode/delegation/status", tokens.runtimeRead, { path: task.hostPath });
    } catch (err) {
      logEvent(`status unreachable: ${err?.name === "TimeoutError" || err?.name === "AbortError" ? "host timeout" : "network error"}`);
      return { kind: "unreachable" };
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: "auth", status: res.status, message: String(res.body?.error ?? "").slice(0, 200) };
    }
    if (!res.ok) {
      logEvent(`status failed status=${res.status}`);
      return { kind: "error", status: res.status };
    }
    if (!isPlainObject(res.body) || typeof res.body.status !== "string") {
      // A9 drift fail-loud: unexpected shape, no guessing.
      logEvent("drift: status response missing status field");
      return { kind: "drift" };
    }
    return { kind: "ok", summary: res.body };
  }

  async function fetchArtifact(task) {
    let res;
    try {
      res = await hostFetch("/opencode/delegation/artifact", tokens.runtimeRead, { path: task.hostPath });
    } catch (err) {
      logEvent(`artifact unreachable: ${err?.name === "TimeoutError" || err?.name === "AbortError" ? "host timeout" : "network error"}`);
      return { kind: "unreachable" };
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: "auth", status: res.status, message: String(res.body?.error ?? "").slice(0, 200) };
    }
    if (!res.ok) {
      logEvent(`artifact failed status=${res.status}`);
      return { kind: "error", status: res.status };
    }
    // A9 + privacy: only the verbatim content crosses; host path/excerpt
    // fields are dropped here by construction.
    if (!isPlainObject(res.body) || typeof res.body.content !== "string") {
      logEvent("drift: artifact response missing content");
      return { kind: "drift" };
    }
    return { kind: "ok", content: res.body.content };
  }

  async function handleTasksGet(id, params) {
    for (const key of Object.keys(params)) {
      if (key !== "id" && key !== "metadata" && key !== "historyLength" && key !== "history_length") {
        return rpcError(id, CODE_INVALID_PARAMS, "Invalid params: params contain an unknown field");
      }
    }
    if (typeof params.id !== "string" || params.id === "") {
      return rpcError(id, CODE_INVALID_PARAMS, "Invalid params: params.id is required");
    }
    const task = tasks.get(params.id);
    if (!task) {
      // Unknown, evicted (table cap), or post-restart orphan — all documented
      // as task-not-found.
      return rpcError(id, CODE_TASK_NOT_FOUND, "Task not found");
    }

    // CANCEL LATCH: terminal locally means terminal forever. A host that
    // completes after our cancel can never flip this back (:1620 vs :1677).
    if (isTerminal(task.state)) {
      return rpcResult(id, taskView(task));
    }

    // Submitted deadline (Critic R1): if start never lands, fail explicitly
    // instead of reporting submitted forever.
    if (task.state === "submitted" && now() - task.createdAt > submittedDeadlineMs) {
      setTaskState(task, "failed", { reason: "bridge: delegation did not leave submitted before the deadline" });
      return rpcResult(id, taskView(task));
    }

    const poll = await pollHostStatus(task);
    if (poll.kind === "auth") {
      // A5: verbatim, no retry. The task state is unchanged.
      return {
        httpStatus: poll.status,
        envelope: {
          jsonrpc: "2.0",
          id: echoableId(id),
          error: { code: CODE_INTERNAL, message: poll.message, data: { upstreamStatus: poll.status } },
        },
      };
    }
    if (poll.kind === "unreachable" || poll.kind === "error" || poll.kind === "drift") {
      return rpcError(id, CODE_INTERNAL, poll.kind === "drift" ? "upstream response shape drift" : "upstream bridge request failed", { data: { upstreamStatus: poll.kind === "error" ? poll.status : 0 } });
    }

    const mapped = STATE_MAP[poll.summary.status];
    if (mapped === undefined) {
      // A9: an unknown host status is drift, not a guess.
      logEvent("drift: unknown host status value");
      return rpcError(id, CODE_INTERNAL, "upstream response shape drift");
    }

    if (mapped === "completed") {
      const artifact = await fetchArtifact(task);
      if (artifact.kind === "auth") {
        return {
          httpStatus: artifact.status,
          envelope: {
            jsonrpc: "2.0",
            id: echoableId(id),
            error: { code: CODE_INTERNAL, message: artifact.message, data: { upstreamStatus: artifact.status } },
          },
        };
      }
      if (artifact.kind !== "ok") {
        return rpcError(id, CODE_INTERNAL, artifact.kind === "drift" ? "upstream response shape drift" : "upstream bridge request failed");
      }
      task.artifact = artifact.content;
      setTaskState(task, "completed");
      return rpcResult(id, taskView(task));
    }

    if (mapped === "failed") {
      const reason = typeof poll.summary.blockedReason === "string" && poll.summary.blockedReason !== ""
        ? redact(poll.summary.blockedReason.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 200)
        : "bridge: delegation failed upstream";
      setTaskState(task, "failed", { reason });
      return rpcResult(id, taskView(task));
    }

    if (mapped === "canceled") {
      // The host cancelled it before we did; latch the same way.
      setTaskState(task, "canceled");
      return rpcResult(id, taskView(task));
    }

    // submitted / working: reflect the observed state.
    setTaskState(task, mapped);
    return rpcResult(id, taskView(task));
  }

  // -- tasks/cancel --------------------------------------------------------------

  async function handleTasksCancel(id, params) {
    for (const key of Object.keys(params)) {
      if (key !== "id" && key !== "metadata") {
        return rpcError(id, CODE_INVALID_PARAMS, "Invalid params: params contain an unknown field");
      }
    }
    if (typeof params.id !== "string" || params.id === "") {
      return rpcError(id, CODE_INVALID_PARAMS, "Invalid params: params.id is required");
    }
    const task = tasks.get(params.id);
    if (!task) {
      return rpcError(id, CODE_TASK_NOT_FOUND, "Task not found");
    }
    if (task.state === "completed" || task.state === "failed") {
      return rpcError(id, CODE_TASK_NOT_CANCELABLE, "Task not cancelable");
    }
    if (task.state === "canceled") {
      return rpcResult(id, taskView(task)); // idempotent
    }

    // LATCH FIRST: from this instruction on, the local task is terminal-
    // canceled regardless of anything the host does next.
    setTaskState(task, "canceled");
    try {
      const res = await hostFetch("/opencode/delegation/cancel", tokens.runtimeControl, { path: task.hostPath });
      if (!res.ok && res.status !== 401 && res.status !== 403) {
        logEvent(`cancel failed status=${res.status}`);
      } else if (res.status === 401 || res.status === 403) {
        // Latch holds; the host-side cancel is best-effort and logged.
        logEvent(`cancel auth failure status=${res.status} error=${redact(String(res.body?.error ?? "")).slice(0, 200)}`);
      }
    } catch {
      logEvent("cancel abandoned: host unreachable (local latch holds)");
    }
    return rpcResult(id, taskView(task));
  }

  // -- dispatch -------------------------------------------------------------------

  async function handleRpc(payload) {
    // Envelope validation per their wire (index.js:106-128):
    // parse errors -> -32700/400 (handled by the HTTP layer); anything not
    // jsonrpc 2.0 with an id -> -32600/400; unknown methods -> -32601/200.
    if (!isPlainObject(payload)) {
      return rpcError(null, CODE_INVALID_REQUEST, "Invalid Request", { httpStatus: 400 });
    }
    const allowedKeys = new Set(["jsonrpc", "id", "method", "params"]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) {
        return rpcError(echoableId(payload.id), CODE_INVALID_REQUEST, "Invalid Request", { httpStatus: 400 });
      }
    }
    if (payload.jsonrpc !== "2.0" || !("id" in payload)) {
      return rpcError(echoableId(payload.id), CODE_INVALID_REQUEST, "Invalid Request", { httpStatus: 400 });
    }
    if (typeof payload.method !== "string" || hasControlChars(payload.method)) {
      return rpcError(echoableId(payload.id), CODE_INVALID_REQUEST, "Invalid Request", { httpStatus: 400 });
    }
    const id = echoableId(payload.id);

    if (!METHODS.includes(payload.method)) {
      // Includes message/stream: everything outside the allowlist -> -32601.
      return rpcError(id, CODE_METHOD_NOT_FOUND, "Method not found");
    }
    if (!isPlainObject(payload.params)) {
      return rpcError(id, CODE_INVALID_PARAMS, "Invalid params: params must be an object");
    }

    if (payload.method === "message/send") {
      return handleMessageSend(id, payload.params);
    }
    if (payload.method === "tasks/get") {
      return handleTasksGet(id, payload.params);
    }
    return handleTasksCancel(id, payload.params);
  }

  function statusPayload() {
    return {
      ok: true,
      addon: ADDON_ID,
      version: ADDON_VERSION,
      a2a: A2A_VERSION,
      target: "opencode",
      methods: METHODS,
      stateMap: STATE_MAP,
      tasksTracked: tasks.size,
      cardUrl: "/.well-known/agent-card.json",
    };
  }

  return { handleRpc, statusPayload, tasks, rateWindow, getBridgeToken: () => tokens.bridge };
}

// -- HTTP layer -------------------------------------------------------------------

export function buildServer({ core }) {
  const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    const finish = (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // A8: log lines carry method, path, status, duration — never bodies,
      // tokens, missions, excerpts, or paths.
      process.stderr.write(`a2a-bridge: ${req.method} ${req.url} ${code} ${ms.toFixed(1)}ms\n`);
    };

    if (req.url === "/.well-known/agent-card.json") {
      serveAgentCard(req, res);
      finish(req.method === "GET" || req.method === "HEAD" ? 200 : 405);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (req.url === "/" || req.url === "/health") {
        reply(res, 200, core.statusPayload());
        finish(200);
      } else {
        reply(res, 404, { error: "not found" }, true);
        finish(404);
      }
      return;
    }

    // Inbound auth (E2E finding: any local process could submit delegations).
    if (req.method === "POST" && req.url === "/") {
      const presented = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const expected = core?.getBridgeToken?.() ?? "";
      if (!expected || presented !== expected) {
        reply(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Unauthorized: bridge token required" } });
        finish(401);
        return;
      }
    }

    if (req.method === "POST" && req.url === "/health") {
      // The ResonantOS http-json health tool (a2abridge.status) lives here so
      // the A2A JSON-RPC surface at POST / stays exactly the three-method
      // allowlist. Same 1..MAX_BODY framing discipline as POST /.
      handleHealthPost(req, res, finish, core);
      return;
    }

    if (req.method !== "POST") {
      reply(res, 405, { error: "method not allowed" }, true);
      finish(405);
      return;
    }
    handlePost(req, res, finish, core);
  });
  // Header-phase stall safety (the body deadline in handlePost is the actual
  // lying-Content-Length enforcement; Node's requestTimeout does not answer
  // 408 for stalled bodies).
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.max(500, Math.min(10000, Math.floor(REQUEST_TIMEOUT_MS / 2)));
  server.keepAliveTimeout = 5000;
  return server;
}

function serveAgentCard(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    reply(res, 405, { error: "Method not allowed. Use GET or HEAD." }, false, { Allow: "GET, HEAD" });
    return;
  }
  const body = req.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(CARD_BYTES, "utf8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    ETag: CARD_ETAG,
    "Content-Length": String(req.method === "HEAD" ? Buffer.byteLength(CARD_BYTES) : body.length),
  });
  res.end(body);
}

function reply(res, code, payload, close = false, extraHeaders = {}) {
  const body = Buffer.from(redact(JSON.stringify(payload)), "utf8");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    ...extraHeaders,
  };
  if (close) headers["Connection"] = "close";
  res.writeHead(code, headers);
  res.end(body, () => {
    // never leave an undrained request body on a keep-alive socket — but a
    // 413 sent mid-stream must not RST before the response reaches the
    // client; the drain/grace path in handlePost owns the socket then.
    if (close) {
      if (res.req?.complete ?? true) res.socket?.destroy();
      else res.socket?.end();
    }
  });
}

function replyEnvelope(res, outcome) {
  const headers = outcome.headers ?? {};
  const body = Buffer.from(redact(JSON.stringify(outcome.envelope)), "utf8");
  res.writeHead(outcome.httpStatus, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    ...headers,
  });
  res.end(body);
}

function handleHealthPost(req, res, finish, core) {
  readBody(req, res, finish, () => {
    reply(res, 200, core.statusPayload());
    finish(200);
  });
}

// Shared body framing for both POST routes: chunked -> 400, missing/bad
// Content-Length -> 400, 1..MAX_BODY enforced (oversized -> 413 + close),
// explicit body-receipt deadline (lying Content-Length -> 408 + close).
function readBody(req, res, finish, onBody) {
  if (req.headers["transfer-encoding"]) {
    reply(res, 400, { error: "transfer-encoding is not accepted; send a fixed Content-Length" }, true);
    finish(400);
    return;
  }
  const raw = req.headers["content-length"];
  if (raw === undefined) {
    reply(res, 400, { error: "content-length is required (1..262144 bytes)" }, true);
    finish(400);
    return;
  }
  const length = Number(raw);
  if (!Number.isInteger(length)) {
    reply(res, 400, { error: "bad content-length" }, true);
    finish(400);
    return;
  }
  if (length <= 0 || length > MAX_BODY) {
    reply(res, 413, { error: "body must be 1..262144 bytes" }, true);
    finish(413);
    return;
  }
  const chunks = [];
  let received = 0;
  let settled = false;
  let bodyTimer = null;
  const clearBodyTimer = () => {
    if (bodyTimer !== null) {
      clearTimeout(bodyTimer);
      bodyTimer = null;
    }
  };
  const fail = (code, message) => {
    if (settled) return;
    settled = true;
    reply(res, code, { error: message }, true);
    finish(code);
  };
  // A lying Content-Length must never pin a socket: explicit body deadline.
  bodyTimer = setTimeout(() => {
    fail(408, "request was not received in full within the timeout; check Content-Length");
    const kill = setTimeout(() => res.socket?.destroy(), 1000);
    kill.unref?.();
  }, REQUEST_TIMEOUT_MS);
  bodyTimer.unref?.();
  req.on("data", (chunk) => {
    if (settled) return;
    received += chunk.length;
    if (received > MAX_BODY) {
      // Drain and discard the surplus so the RST from the eventual socket
      // destroy cannot swallow the 413 on the client side.
      req.resume();
      clearBodyTimer();
      const grace = setTimeout(() => res.socket?.destroy(), 5000);
      grace.unref?.();
      req.on("end", () => res.socket?.destroy());
      fail(413, "body must be 1..262144 bytes");
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => {
    clearBodyTimer();
    settled = true; // client vanished; response is moot
    res.socket?.destroy();
  });
  req.on("close", clearBodyTimer);
  req.on("end", () => {
    clearBodyTimer();
    if (settled) return;
    settled = true;
    onBody(Buffer.concat(chunks));
  });
}

function handlePost(req, res, finish, core) {
  if (req.url !== "/") {
    reply(res, 404, { error: "not found" }, true);
    finish(404);
    return;
  }
  readBody(req, res, finish, (body) => {
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      // -32700 Parse error, HTTP 400, id null (their index.js:110).
      replyEnvelope(res, { httpStatus: 400, envelope: { jsonrpc: "2.0", id: null, error: { code: CODE_PARSE, message: "Parse error" } } });
      finish(400);
      return;
    }
    Promise.resolve(core.handleRpc(payload))
      .then((outcome) => {
        replyEnvelope(res, outcome);
        finish(outcome.httpStatus);
      })
      .catch(() => {
        // The dispatch itself must never crash the connection.
        replyEnvelope(res, { httpStatus: 200, envelope: { jsonrpc: "2.0", id: null, error: { code: CODE_INTERNAL, message: "Internal error" } } });
        finish(200);
      });
  });
}

async function main() {
  // A0 FIRST: fail loud before anything binds.
  const envCheck = checkRequiredEnv();
  if (!envCheck.ok) {
    process.stderr.write(setupInstructions(envCheck.missing) + "\n");
    process.exit(78);
  }

  const core = createBridgeCore();
  const server = buildServer({ core });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "127.0.0.1", resolve);
    });
  } catch (err) {
    process.stderr.write(`a2a-bridge: cannot bind 127.0.0.1:${PORT} (${err.code ?? err.message}); manifest entrypoint expects this port\n`);
    process.exit(78);
  }
  log(`A2A ${A2A_VERSION} bridge listening on http://127.0.0.1:${PORT} (target: opencode via ${redact(HOST_BASE_URL)})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { AGENT_CARD, CARD_BYTES, CARD_ETAG, checkRequiredEnv, setupInstructions, REQUIRED_TOKEN_ENVS, STATE_MAP, METHODS, MAX_BODY, ADDON_ID, ADDON_VERSION, A2A_VERSION };
