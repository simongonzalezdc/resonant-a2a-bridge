// addon.a2a-bridge test suite — PRD acceptance criteria A0, A2-A10.
//
// Runner: node's built-in test runner (this add-on's service is Node with
// exported testable pieces; the adapted sibling convention).
//
// Run:  node --test tests/          (from the add-on root)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDON_ID,
  ADDON_VERSION,
  A2A_VERSION,
  AGENT_CARD,
  CARD_BYTES,
  CARD_ETAG,
  METHODS,
  REQUIRED_TOKEN_ENVS,
  STATE_MAP,
  buildServer,
  checkRequiredEnv,
  createBridgeCore,
  setupInstructions,
} from "../server.mjs";
import { ARTIFACT_CONTENT, NEEDLES, createStubHost } from "./stub-host.mjs";

const ADDON_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DUMMY_ENV = {
  RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN: "dummy-bridge-token-A7",
  RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN: "dummy-record-write-token-B3",
  RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN: "dummy-runtime-control-token-C9",
  RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN: "dummy-runtime-read-token-D1",
};

const MISSION = "Report the public functions of the parser module ZZMYSPECIALMISSIONPHRASE";

// Privacy needles: never allowed in any response or log line. The artifact
// marker is deliberately NOT in this list (the verbatim artifact carries it).
const FORBIDDEN_NEEDLES = [
  NEEDLES.mission,
  NEEDLES.context,
  NEEDLES.excerpt,
  NEEDLES.fakePath,
  "/Users/",
  os.homedir(),
  MISSION,
];

function assertNoLeaks(text, where) {
  for (const needle of FORBIDDEN_NEEDLES) {
    if (needle && text.includes(needle)) {
      assert.fail(`leak in ${where}: needle ${JSON.stringify(needle.slice(0, 40))} appeared`);
    }
  }
}

// -- helpers --------------------------------------------------------------------

async function listenEphemeral(core) {
  const server = buildServer({ core });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, port };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function postRpc(port, payload, { raw } = {}) {
  const body = raw ?? JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* framing error bodies are JSON too; keep null on surprises */ }
  return { status: res.status, text, json };
}

async function get(port, pathname, { method = "GET" } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers };
}

function missionMessage(mission = MISSION, extra = {}) {
  return {
    kind: "message",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    parts: [{ kind: "text", text: mission }],
    ...extra,
  };
}

// Raw-socket request for framing probes: full response text + whether the
// server explicitly closed the connection.
function rawSend(port, raw, { timeoutMs = 8000, settleMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    let closed = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ received, closed });
      socket.destroy();
    };
    socket.setTimeout(timeoutMs, done);
    socket.on("data", (d) => {
      received += d.toString();
      if (closed || !received.includes("\r\n\r\n")) return;
      const length = Number(/Content-Length: (\d+)/i.exec(received)?.[1] ?? NaN);
      if (Number.isNaN(length)) return;
      const bodyStart = received.indexOf("\r\n\r\n") + 4;
      if (received.length - bodyStart >= length) {
        setTimeout(done, settleMs); // a beat to observe an explicit close
      }
    });
    socket.on("close", () => {
      closed = true;
      done();
    });
    socket.on("error", (err) => {
      if (!settled) reject(err);
    });
    socket.on("connect", () => socket.write(raw));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Spawns server.mjs as a child. Resolves once the child either exits (A0
// refusal, bind failure) or answers /health with a 2xx.
function spawnService(env, port, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
      env: { ...process.env, ...env, A2A_BRIDGE_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`service spawn timed out\n${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ child, exitCode: code, stderr, exited: true });
    });
    (async () => {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) return;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
          if (res.ok) {
            clearTimeout(timer);
            resolve({ child, exitCode: null, stderr, exited: false });
            return;
          }
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      clearTimeout(timer);
      reject(new Error(`service did not come up on ${port}\n${stderr}`));
    })();
  });
}

// -- A0: fail-loud startup -------------------------------------------------------

describe("A0: operator-token fail-loud startup", () => {
  it("checkRequiredEnv flags each missing token and passes a complete set", () => {
    const empty = checkRequiredEnv({});
    assert.equal(empty.ok, false);
    assert.deepEqual(empty.missing.map((m) => m.env), REQUIRED_TOKEN_ENVS.map((m) => m.env));
    const oneEmpty = checkRequiredEnv({ ...DUMMY_ENV, RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN: "   " });
    assert.equal(oneEmpty.ok, false);
    assert.deepEqual(oneEmpty.missing.map((m) => m.env), ["RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN"]);
    assert.equal(checkRequiredEnv(DUMMY_ENV).ok, true);
  });

  it("setup instructions name the missing env vars but never echo token values", () => {
    const text = setupInstructions(checkRequiredEnv({}).missing);
    for (const { env } of REQUIRED_TOKEN_ENVS) assert.ok(text.includes(env), `missing ${env}`);
    assert.ok(text.includes("RESONANTOS_BROWSER_FIRST_"), "points at the launcher-minted family");
    assert.ok(!text.includes("dummy-"), "never echoes a token value");
  });

  it("exits 78 with setup instructions when no tokens are set", async () => {
    const port = await freePort();
    const { child, exitCode, stderr } = await spawnService({}, port);
    assert.equal(exitCode, 78);
    child.removeAllListeners();
    assert.ok(stderr.includes("refusing to start"));
    for (const { env } of REQUIRED_TOKEN_ENVS) assert.ok(stderr.includes(env));
    assertNoLeaks(stderr, "A0 stderr");
  });

  it("exits 78 on an invalid dev port and on a non-loopback target URL", async () => {
    const badPort = await freePort();
    const a = await spawnService(DUMMY_ENV, badPort, { timeoutMs: 4000 }).catch(() => null);
    // spawnService resolves on health or exit; force kill then re-run precisely:
    a?.child.kill("SIGKILL");

    const port = await freePort();
    const bad = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
        env: { ...process.env, ...DUMMY_ENV, A2A_BRIDGE_PORT: "99999" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(bad.code, 78);
    assert.ok(bad.stderr.includes("A2A_BRIDGE_PORT"));

    const port2 = await freePort();
    const wide = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
        env: { ...process.env, ...DUMMY_ENV, A2A_BRIDGE_PORT: String(port2), A2A_BRIDGE_TARGET_URL: "http://10.0.0.5:47773" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(wide.code, 78);
    assert.ok(wide.stderr.includes("loopback"));
  });

  it("exits 78 on bind conflict (the manifest entrypoint is the contract)", async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address();
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
        env: { ...process.env, ...DUMMY_ENV, A2A_BRIDGE_PORT: String(port) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    blocker.close();
    assert.equal(result.code, 78);
    assert.ok(result.stderr.includes("cannot bind 127.0.0.1:"));
  });

  it("boots and answers /health when the operator env is complete", async () => {
    const port = await freePort();
    const { child, exitCode, stderr } = await spawnService(DUMMY_ENV, port);
    assert.equal(exitCode, null);
    try {
      const res = await get(port, "/health");
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.a2a, "0.2.5");
      assert.ok(stderr.includes("listening on http://127.0.0.1:"));
      assert.ok(!stderr.includes("dummy-bridge-token-A7"), "boot line never carries a token value");
    } finally {
      child.kill("SIGTERM");
    }
  });
});

// -- A2: agent card byte lock ----------------------------------------------------

describe("A2: agent card (production-reference shape, bridge-own identity)", () => {
  let app;
  before(async () => {
    const core = createBridgeCore({ env: DUMMY_ENV, fetchImpl: async () => { throw new Error("no host in this test"); } });
    app = await listenEphemeral(core);
  });
  after(async () => closeServer(app.server));

  it("serves byte-locked card bytes with a pinned SHA-256", async () => {
    assert.equal(createHash("sha256").update(CARD_BYTES).digest("hex"), "639f8ed2c965298dd05107049d805704c8aae6dd8a58fa1633a3a694e69a4b5b");
    const res = await get(app.port, "/.well-known/agent-card.json");
    assert.equal(res.status, 200);
    assert.equal(res.text, CARD_BYTES);
    const served = JSON.parse(res.text);
    assert.deepEqual(served, AGENT_CARD);
  });

  it("ETag is present and stable; HEAD has no body but identical headers", async () => {
    const first = await get(app.port, "/.well-known/agent-card.json");
    const second = await get(app.port, "/.well-known/agent-card.json");
    assert.equal(first.headers.get("etag"), CARD_ETAG);
    assert.equal(second.headers.get("etag"), CARD_ETAG);
    const head = await get(app.port, "/.well-known/agent-card.json", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal(head.headers.get("etag"), CARD_ETAG);
    assert.ok(Number(head.headers.get("content-length")) > 0);
  });

  it("production-reference shape: interfaces carry protocolVersion, capabilities all false", () => {
    const card = JSON.parse(CARD_BYTES);
    assert.equal(card.supportedInterfaces.length, 1);
    assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
    assert.equal(card.supportedInterfaces[0].protocolVersion, "0.2.5");
    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.capabilities.extendedAgentCard, false);
    // No invented top-level fields: every key exists on the production reference.
    const REFERENCE_KEYS = ["name", "description", "supportedInterfaces", "provider", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills", "documentationUrl", "iconUrl"];
    for (const key of Object.keys(card)) assert.ok(REFERENCE_KEYS.includes(key), `invented field: ${key}`);
  });

  it("card identity is the bridge's own — zero PuenteWorks content", () => {
    const lower = CARD_BYTES.toLowerCase();
    for (const banned of ["puenteworks", "kinocut", "kyanitelabs.tech", "service guide", "cal.com", "simon gonzalez"]) {
      assert.ok(!lower.includes(banned), `card must not carry ${banned}`);
    }
    const card = JSON.parse(CARD_BYTES);
    assert.equal(card.name, "A2A Bridge (ResonantOS delegation)");
    assert.ok(card.description.includes("opencode"));
    assert.equal(card.skills.length, 1);
    assert.ok(card.skills[0].id.includes("opencode"));
    assert.ok(card.supportedInterfaces[0].url.startsWith("http://127.0.0.1:4898"));
  });

  it("405 for non-GET/HEAD with Allow header", async () => {
    const post = await fetch(`http://127.0.0.1:${app.port}/.well-known/agent-card.json`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    const del = await get(app.port, "/.well-known/agent-card.json", { method: "DELETE" });
    assert.equal(del.status, 405);
  });
});

// -- wire contract: the -32xxx matrix ---------------------------------------------

describe("wire contract: JSON-RPC envelope and error matrix", () => {
  let app;
  before(async () => {
    const core = createBridgeCore({ env: DUMMY_ENV, fetchImpl: async () => { throw new Error("no host in this test"); } });
    app = await listenEphemeral(core);
  });
  after(async () => closeServer(app.server));

  it("-32700 Parse error, HTTP 400, id null", async () => {
    const res = await postRpc(app.port, undefined, { raw: "{not json" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("-32600 Invalid Request, HTTP 400: non-2.0, missing id, array, string body, unknown top-level field", async () => {
    for (const payload of [
      { jsonrpc: "1.0", id: 1, method: "tasks/get", params: { id: "x" } },
      { jsonrpc: "2.0", method: "tasks/get", params: { id: "x" } },
      [1, 2, 3],
      "hello",
      { jsonrpc: "2.0", id: 7, method: "tasks/get", params: { id: "x" }, extra: true },
    ]) {
      const res = await postRpc(app.port, payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal(res.json.error.code, -32600, JSON.stringify(payload));
      assert.equal(res.json.error.message, "Invalid Request");
      assert.equal(res.json.jsonrpc, "2.0");
    }
    // A scalar id survives as id.
    const resId = await postRpc(app.port, { jsonrpc: "1.0", id: 42, method: "tasks/get", params: { id: "x" } });
    assert.equal(resId.json.id, 42);
    // Their wire does not validate id TYPE (index.js:113 checks only presence);
    // a non-scalar id proceeds but is NEVER echoed back as structure.
    const resObj = await postRpc(app.port, { jsonrpc: "2.0", id: { object: true }, method: "tasks/get", params: { id: "tsk_nope" } });
    assert.equal(resObj.status, 200);
    assert.equal(resObj.json.error.code, -32001);
    assert.equal(resObj.json.id, null);
  });

  it("-32601 Method not found (HTTP 200) for message/stream and everything unknown", async () => {
    for (const method of ["message/stream", "SendMessage", "tasks/cancel/extra", "message/send ", "", "a/b/c"]) {
      const res = await postRpc(app.port, { jsonrpc: "2.0", id: 9, method, params: {} });
      assert.equal(res.status, 200, method);
      assert.deepEqual(res.json.error, { code: -32601, message: "Method not found" });
      assert.equal(res.json.id, 9);
    }
    assert.ok(METHODS.includes("message/send") && METHODS.includes("tasks/get") && METHODS.includes("tasks/cancel"));
  });

  it("-32602 for params shapes: missing params, missing parts, empty parts, no text/data part", async () => {
    const missingParams = await postRpc(app.port, { jsonrpc: "2.0", id: 1, method: "message/send" });
    assert.deepEqual(missingParams.json.error, { code: -32602, message: "Invalid params: params must be an object" });

    const noParts = await postRpc(app.port, { jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { kind: "message" } } });
    assert.equal(noParts.json.error.code, -32602);
    assert.equal(noParts.json.error.message, "Invalid params: message.parts is required");

    const emptyParts = await postRpc(app.port, { jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { parts: [] } } });
    assert.equal(emptyParts.json.error.message, "Invalid params: message.parts is required");

    const noText = await postRpc(app.port, { jsonrpc: "2.0", id: 4, method: "message/send", params: { message: { parts: [{ kind: "text" }] } } });
    assert.equal(noText.json.error.message, "Invalid params: a text or data part is required");

    const unknownField = await postRpc(app.port, { jsonrpc: "2.0", id: 5, method: "message/send", params: { message: missionMessage(), historyLength: 3 } });
    assert.equal(unknownField.json.error.message, "Invalid params: params contain an unknown field");
  });

  it("-32602 for mission bounds: <8 chars (their minimum), >24k (our cap), control chars", async () => {
    const short = await postRpc(app.port, { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "short" }] } } });
    assert.equal(short.json.error.code, -32602);
    assert.equal(short.json.error.message, "Invalid params: mission must be at least 8 characters");
    assert.ok(!short.text.includes("short"), "mission text never echoes back");

    const big = "x".repeat(24_001);
    const tooBig = await postRpc(app.port, { jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { parts: [{ kind: "text", text: big }] } } });
    assert.equal(tooBig.json.error.message, "Invalid params: mission must be at most 24000 characters");

    const exact = "x".repeat(24_000);
    const okBody = await postRpc(app.port, { jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { parts: [{ kind: "text", text: exact }] } } });
    assert.ok(okBody.json.error === undefined || okBody.json.error.code !== -32602, "exactly 24000 passes mission cap");

    const ctrl = await postRpc(app.port, { jsonrpc: "2.0", id: 4, method: "message/send", params: { message: { parts: [{ kind: "text", text: "a mission with \u0001 control" }] } } });
    assert.equal(ctrl.json.error.message, "Invalid params: mission contains control characters");

    // \t \n \r are legitimate whitespace
    const ws = "a mission\nwith\ttabs and newlines";
    const wsRes = await postRpc(app.port, { jsonrpc: "2.0", id: 5, method: "message/send", params: { message: { parts: [{ kind: "text", text: ws }] } } });
    assert.notEqual(wsRes.json.error?.message, "Invalid params: mission contains control characters");
  });

  it("data parts stringify into the mission; multiple text parts join with spaces", async () => {
    const seen = [];
    const core = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), body: init.body });
        if (String(url).endsWith("/addons/delegate")) {
          return { status: 200, body: { ok: true, id: "op-1", path: "BrowserFirst/Delegations/opencode/op-1.md", status: "queued" } };
        }
        return { status: 200, body: { ok: true } };
      },
    });
    const outcome = await core.handleRpc({
      jsonrpc: "2.0", id: "d1", method: "message/send",
      params: { message: { parts: [{ kind: "text", text: "first part" }, { kind: "data", data: { k: "v" } }, { kind: "text", text: "tail" }] } },
    });
    assert.equal(outcome.envelope.result.status.state, "submitted");
    const delegateBody = JSON.parse(seen.find((s) => s.url.endsWith("/addons/delegate")).body);
    assert.equal(delegateBody.mission, 'first part {"k":"v"} tail');
  });

  it("-32602 for tasks/get and tasks/cancel param shapes; SDK-legal optional fields accepted", async () => {
    for (const method of ["tasks/get", "tasks/cancel"]) {
      const missing = await postRpc(app.port, { jsonrpc: "2.0", id: 1, method, params: {} });
      assert.equal(missing.json.error.message, "Invalid params: params.id is required", method);
      const nonString = await postRpc(app.port, { jsonrpc: "2.0", id: 2, method, params: { id: 123 } });
      assert.equal(nonString.json.error.message, "Invalid params: params.id is required", method);
      const unknown = await postRpc(app.port, { jsonrpc: "2.0", id: 3, method, params: { id: "x", bogus: 1 } });
      assert.equal(unknown.json.error.message, "Invalid params: params contain an unknown field", method);
      const unknownTask = await postRpc(app.port, { jsonrpc: "2.0", id: 4, method, params: { id: "tsk_nope" } });
      assert.deepEqual(unknownTask.json.error, { code: -32001, message: "Task not found" }, method);
    }
    const withSdkFields = await postRpc(app.port, { jsonrpc: "2.0", id: 5, method: "tasks/get", params: { id: "tsk_nope", history_length: 8, metadata: {} } });
    assert.equal(withSdkFields.json.error.code, -32001, "history_length/metadata accepted then not-found");
  });
});

// -- A3: real round-trip vs a SLEEPING stub host -----------------------------------

describe("A3: round-trip vs sleeping stub (un-awaited start, lifecycle, artifact verbatim)", () => {
  let stub;
  let app;
  let responseLog = [];
  before(async () => {
    stub = await createStubHost({ startDelayMs: 1500 });
    const core = createBridgeCore({ env: DUMMY_ENV, targetBaseUrl: stub.url });
    app = await listenEphemeral(core);
  });
  after(async () => {
    await closeServer(app.server);
    await stub.close();
  });

  function record(where, text) {
    responseLog.push({ where, text });
  }

  it("message/send returns submitted BEFORE the stub's start completes (un-awaited start)", async () => {
    const t0 = Date.now();
    const res = await postRpc(app.port, { jsonrpc: "2.0", id: "a3-1", method: "message/send", params: { message: missionMessage(MISSION, { contextId: "ctx-client-777" }) } });
    const rtt = Date.now() - t0;
    record("message/send", res.text);
    assert.equal(res.status, 200);
    assert.equal(res.json.result.status.state, "submitted");
    assert.match(res.json.result.id, /^tsk_[0-9a-f-]{36}$/);
    assert.equal(res.json.result.contextId, "ctx-client-777");
    assert.ok(res.json.result.status.timestamp, "status carries a timestamp");
    // THE proof: the response landed while the stub's start was still sleeping.
    assert.ok(rtt < 1400, `send must not await start (rtt=${rtt}ms, start sleeps 1500ms)`);
    // start was FIRED (not awaited): give the fire-and-forget request a moment
    // to reach the stub, then confirm it arrived — while the send RTT stays
    // far below the stub's start latency.
    for (let i = 0; i < 50 && stub.state.starts === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(stub.state.starts >= 1, "start was fired");
    globalThis.__a3TaskId = res.json.result.id;
  });

  it("poll observes working while the stub runs, then completed with the verbatim artifact", async () => {
    const taskId = globalThis.__a3TaskId;
    // Immediately after send: the stub start has been called, task may read
    // queued (submitted) or running (working); by construction it cannot be
    // completed yet.
    const early = await postRpc(app.port, { jsonrpc: "2.0", id: "a3-2", method: "tasks/get", params: { id: taskId } });
    record("tasks/get early", early.text);
    assert.equal(early.status, 200);
    assert.ok(["submitted", "working"].includes(early.json.result.status.state), `early=${early.json.result.status.state}`);

    // Wait past the stub's completion point, then poll.
    await new Promise((r) => setTimeout(r, 1700));
    const done = await postRpc(app.port, { jsonrpc: "2.0", id: "a3-3", method: "tasks/get", params: { id: taskId } });
    record("tasks/get completed", done.text);
    assert.equal(done.json.result.status.state, "completed");
    assert.equal(done.json.result.artifactRef.content, ARTIFACT_CONTENT, "artifact verbatim");
    assert.equal(done.json.result.artifactRef.mimeType, "text/markdown");
    assert.ok(done.json.result.artifactRef.content.includes(NEEDLES.artifact));
    // A4b: state + artifactRef only — no history, no host passthrough.
    assert.equal(done.json.result.history, undefined);
    const keys = Object.keys(done.json.result);
    assert.deepEqual(keys.sort(), ["artifactRef", "contextId", "id", "status"]);
  });

  it("the bridge authenticated with the right capability token on every host route", () => {
    assert.deepEqual(stub.state.delegateAuthHeaders, ["dummy-record-write-token-B3"]);
    assert.deepEqual(stub.state.startAuthHeaders.filter((t) => t), ["dummy-runtime-control-token-C9"]);
    assert.ok(stub.state.statusAuthHeaders.every((t) => t === "dummy-runtime-read-token-D1"));
    assert.deepEqual(stub.state.artifactAuthHeaders, ["dummy-runtime-read-token-D1"]);
    assert.ok(stub.state.bridgeTokens.every((t) => t === "dummy-bridge-token-A7"));
  });

  it("A10: delegate packet bytes are deterministic modulo ids/timestamps", () => {
    assert.ok(stub.state.delegateBodies.length >= 1);
    const body = JSON.parse(stub.state.delegateBodies[0]);
    assert.deepEqual(body, { target: "opencode", mission: MISSION, source: "a2a-bridge" });
    const raw = stub.state.delegateBodies[0];
    assert.equal(raw, JSON.stringify({ target: "opencode", mission: MISSION, source: "a2a-bridge" }), "stable key order");
  });

  it("privacy: planted host needles never appear in any response", () => {
    for (const { where, text } of responseLog) assertNoLeaks(text, where);
  });
});

// -- A4: cancel latch ----------------------------------------------------------------

describe("A4: cancel latch (host completing after cancel cannot flip the state)", () => {
  let stub;
  let app;
  let taskId;
  before(async () => {
    stub = await createStubHost({ startDelayMs: 900 });
    const core = createBridgeCore({ env: DUMMY_ENV, targetBaseUrl: stub.url });
    app = await listenEphemeral(core);
  });
  after(async () => {
    await closeServer(app.server);
    await stub.close();
  });

  it("cancel latches canceled immediately and returns the canceled task", async () => {
    const sent = await postRpc(app.port, { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Cancel latch probe mission") } });
    taskId = sent.json.result.id;
    const cancel = await postRpc(app.port, { jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: taskId } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.result.status.state, "canceled");
    assert.equal(cancel.json.result.artifactRef, undefined);
    assert.equal(stub.state.cancelCalls, 1, "host cancel was forwarded");
  });

  it("a stub that completes AFTER the cancel still reads canceled (their :1620 vs :1677 race, latched)", async () => {
    await new Promise((r) => setTimeout(r, 1200)); // stub start finished; host packet now says completed
    const after = await postRpc(app.port, { jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: taskId } });
    assert.equal(after.status, 200);
    assert.equal(after.json.result.status.state, "canceled", "latch wins over host completion");
    assert.equal(after.json.result.artifactRef, undefined, "no artifact surfaces on a canceled task");
  });

  it("cancel is idempotent; canceling completed/failed tasks is -32002", async () => {
    const again = await postRpc(app.port, { jsonrpc: "2.0", id: 4, method: "tasks/cancel", params: { id: taskId } });
    assert.equal(again.json.result.status.state, "canceled");
    assert.equal(stub.state.cancelCalls, 1, "second cancel does not re-hit the host");

    // A completed task cannot be canceled: build a core whose host behavior
    // is swappable mid-test (the core captures the fetchImpl binding, so the
    // swap happens inside the holder).
    const behavior = {
      current: async (url) => {
        const u = String(url);
        if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "p.md", status: "queued" } };
        if (u.endsWith("/status")) return { status: 200, body: { ok: true, status: "completed", path: "p.md" } };
        if (u.endsWith("/artifact")) return { status: 200, body: { ok: true, content: "final artifact" } };
        return { status: 200, body: { ok: true, path: "p.md", status: "queued" } };
      },
    };
    const core = createBridgeCore({ env: DUMMY_ENV, fetchImpl: (url) => behavior.current(url) });
    const sent = await core.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Terminal state probe mission") } });
    const id = sent.envelope.result.id;
    const completed = await core.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id } });
    assert.equal(completed.envelope.result.status.state, "completed");
    const lateCancel = await core.handleRpc({ jsonrpc: "2.0", id: 3, method: "tasks/cancel", params: { id } });
    assert.deepEqual(lateCancel.envelope.error, { code: -32002, message: "Task not cancelable" });
  });
});

// -- state map + blocked/failed + A5 verbatim auth failures + A9 drift --------------

describe("state map, A5 verbatim auth failures, A9 drift fail-loud (injected host)", () => {
  function coreFor(routeBehavior) {
    return createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async (url) => {
        const u = String(url);
        const handler = routeBehavior[u.slice(u.lastIndexOf("/", 0) === 0 ? 0 : u.indexOf("127.0.0.1") + 9)] ?? routeBehavior.default;
        return handler(u);
      },
    });
  }

  it("state map matrix: queued/blocked/failed/cancelled map per (d)", async () => {
    assert.deepEqual(STATE_MAP, {
      queued: "submitted", running: "working", completed: "completed",
      blocked: "failed", failed: "failed", cancelled: "canceled",
    });

    async function scenario(hostStatus, expectedState, extraExpect = {}) {
      const core = createBridgeCore({
        env: DUMMY_ENV,
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "Delegations/opencode/op-1.md", status: "queued" } };
          if (u.endsWith("/opencode/delegation/start")) return { status: 200, body: { ok: true, status: hostStatus } };
          if (u.endsWith("/opencode/delegation/status")) return { status: 200, body: { ok: true, status: hostStatus, ...(hostStatus === "blocked" ? { blockedReason: "OpenCode CLI unavailable" } : {}) } };
          if (u.endsWith("/opencode/delegation/artifact")) return { status: 200, body: { ok: true, content: "content" } };
          return { status: 200, body: { ok: true } };
        },
      });
      const sent = await core.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("State mapping probe mission") } });
      const got = await core.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent.envelope.result.id } });
      assert.equal(got.envelope.result.status.state, expectedState, hostStatus);
      if (extraExpect.reason) {
        assert.ok(got.envelope.result.status.message.parts[0].text.includes(extraExpect.reason));
      }
      return { core, id: sent.envelope.result.id };
    }

    await scenario("queued", "submitted");
    await scenario("running", "working");
    await scenario("completed", "completed");
    const blocked = await scenario("blocked", "failed", { reason: "OpenCode CLI unavailable" });
    const failed = await scenario("failed", "failed");
    await scenario("cancelled", "canceled");

    // A failed/blocked task is terminal locally: further polls do not touch the host.
    const before = failed.core.tasks.get(failed.id);
    const second = await failed.core.handleRpc({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: failed.id } });
    assert.equal(second.envelope.result.status.state, "failed");
    assert.equal(before.timestamp, second.envelope.result.status.timestamp);
  });

  it("A5: host 401 on delegate is surfaced verbatim, exactly once, no retries", async () => {
    let calls = 0;
    const core = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async () => {
        calls += 1;
        return { status: 401, body: { ok: false, error: "Unauthorized browser-first bridge request." } };
      },
    });
    const res = await core.handleRpc({ jsonrpc: "2.0", id: 5, method: "message/send", params: { message: missionMessage("Auth failure probe mission") } });
    assert.equal(res.httpStatus, 401, "their 401 status mirrored");
    assert.equal(res.envelope.error.code, -32603);
    assert.equal(res.envelope.error.message, "Unauthorized browser-first bridge request.");
    assert.equal(res.envelope.error.data.upstreamStatus, 401);
    assert.equal(calls, 1, "no retry");
    assert.equal(core.tasks.size, 0, "no task registered on auth failure");
  });

  it("A5: host 403 on delegate is surfaced verbatim, exactly once", async () => {
    let calls = 0;
    const core = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async () => {
        calls += 1;
        return { status: 403, body: { ok: false, error: "Bridge route requires addon-record-write capability." } };
      },
    });
    const res = await core.handleRpc({ jsonrpc: "2.0", id: 5, method: "message/send", params: { message: missionMessage("Capability probe mission") } });
    assert.equal(res.httpStatus, 403);
    assert.equal(res.envelope.error.message, "Bridge route requires addon-record-write capability.");
    assert.equal(calls, 1);
  });

  it("A5: 401 during tasks/get poll mirrors 401 without changing task state", async () => {
    const core = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "Delegations/opencode/op-2.md", status: "queued" } };
        if (u.endsWith("/opencode/delegation/status")) return { status: 401, body: { ok: false, error: "Unauthorized browser-first bridge request." } };
        return { status: 200, body: { ok: true } };
      },
    });
    const sent = await core.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Poll auth probe mission") } });
    const got = await core.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent.envelope.result.id } });
    assert.equal(got.httpStatus, 401);
    assert.equal(got.envelope.error.message, "Unauthorized browser-first bridge request.");
    assert.equal(core.tasks.get(sent.envelope.result.id).state, "submitted");
  });

  it("A9 drift: delegate without path / status without status / unknown status / artifact without content all fail loud", async () => {
    // delegate missing path
    const driftCore = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async () => ({ status: 200, body: { ok: true, id: "op-1", status: "queued" } }),
    });
    const drift = await driftCore.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Drift probe mission one") } });
    assert.deepEqual(drift.envelope.error, { code: -32603, message: "upstream response shape drift" });
    assert.equal(driftCore.tasks.size, 0);

    // status missing the status field
    const noStatusCore = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "p.md", status: "queued" } };
        if (u.endsWith("/opencode/delegation/status")) return { status: 200, body: { ok: true, id: "op-1" } };
        return { status: 200, body: { ok: true } };
      },
    });
    const sent = await noStatusCore.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Drift probe mission two") } });
    const polled = await noStatusCore.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent.envelope.result.id } });
    assert.equal(polled.envelope.error.message, "upstream response shape drift");
    assert.equal(noStatusCore.tasks.get(sent.envelope.result.id).state, "submitted", "drift does not mutate task state");

    // unknown status value
    const weirdCore = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "p.md", status: "queued" } };
        if (u.endsWith("/opencode/delegation/status")) return { status: 200, body: { ok: true, status: "teleported" } };
        return { status: 200, body: { ok: true } };
      },
    });
    const sent2 = await weirdCore.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Drift probe mission tri") } });
    const polled2 = await weirdCore.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent2.envelope.result.id } });
    assert.equal(polled2.envelope.error.message, "upstream response shape drift");

    // artifact without content
    const noArtifactCore = createBridgeCore({
      env: DUMMY_ENV,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "p.md", status: "queued" } };
        if (u.endsWith("/opencode/delegation/status")) return { status: 200, body: { ok: true, status: "completed" } };
        if (u.endsWith("/opencode/delegation/artifact")) return { status: 200, body: { ok: true, path: "p-result.md", finalSummary: "nope" } };
        return { status: 200, body: { ok: true } };
      },
    });
    const sent3 = await noArtifactCore.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Drift probe mission fur") } });
    const polled3 = await noArtifactCore.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent3.envelope.result.id } });
    assert.equal(polled3.envelope.error.message, "upstream response shape drift");
  });
});

// -- A4b/-32001: bounded task table, restart orphans ---------------------------------

describe("A4b: bounded task table and not-found semantics", () => {
  function busyCore(maxTasks) {
    return createBridgeCore({
      env: DUMMY_ENV,
      limits: { maxTasks, maxConcurrent: 1000, rateMax: 10_000 },
      fetchImpl: async () => ({ status: 200, body: { ok: true, path: "Delegations/opencode/op-x.md", status: "queued" } }),
    });
  }

  it("the table holds the last 64; evicted and unknown ids read back -32001", async () => {
    const core = busyCore(64);
    const ids = [];
    for (let i = 0; i < 66; i++) {
      const sent = await core.handleRpc({ jsonrpc: "2.0", id: i, method: "message/send", params: { message: missionMessage(`Table bound probe mission ${String(i).padStart(3, "0")}`) } });
      ids.push(sent.envelope.result.id);
    }
    assert.equal(core.tasks.size, 64);
    const evicted = await core.handleRpc({ jsonrpc: "2.0", id: "x", method: "tasks/get", params: { id: ids[0] } });
    assert.deepEqual(evicted.envelope.error, { code: -32001, message: "Task not found" });
    const newest = await core.handleRpc({ jsonrpc: "2.0", id: "y", method: "tasks/get", params: { id: ids[65] } });
    assert.equal(newest.envelope.result.id, ids[65]);
  });

  it("a fresh process (restart) orphans every previous id as -32001", async () => {
    const first = busyCore(64);
    const sent = await first.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Restart orphan probe mission") } });
    const second = busyCore(64);
    const got = await second.handleRpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent.envelope.result.id } });
    assert.deepEqual(got.envelope.error, { code: -32001, message: "Task not found" });
  });
});

// -- A7: limits — concurrency, rolling rate window ------------------------------------

describe("A7: concurrency and rolling-window rate limits (injected clock)", () => {
  function makeTick() {
    let t = 1_700_000_000_000;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  function holdingCore({ now, limits }) {
    return createBridgeCore({
      env: DUMMY_ENV,
      now,
      limits,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/addons/delegate")) return { status: 200, body: { ok: true, path: "Delegations/opencode/op-h.md", status: "queued" } };
        if (u.endsWith("/opencode/delegation/status")) return { status: 200, body: { ok: true, status: "running" } };
        return { status: 200, body: { ok: true } };
      },
    });
  }

  it("one delegation at a time: a second send while active is 429", async () => {
    const clock = makeTick();
    const core = holdingCore({ now: clock.now, limits: { rateMax: 100 } });
    const first = await core.handleRpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage("Concurrency probe mission") } });
    assert.equal(first.httpStatus, 200);
    const second = await core.handleRpc({ jsonrpc: "2.0", id: 2, method: "message/send", params: { message: missionMessage("Concurrency probe mission") } });
    assert.equal(second.httpStatus, 429);
    assert.match(second.envelope.error.message, /concurrency limit/);
    assert.ok(second.headers["Retry-After"]);
    // cancel frees the slot
    await core.handleRpc({ jsonrpc: "2.0", id: 3, method: "tasks/cancel", params: { id: first.envelope.result.id } });
    const third = await core.handleRpc({ jsonrpc: "2.0", id: 4, method: "message/send", params: { message: missionMessage("Concurrency probe mission") } });
    assert.equal(third.httpStatus, 200);
  });

  it("rolling window: 6 per hour, the 7th is 429, the window genuinely rolls", async () => {
    const clock = makeTick();
    const core = createBridgeCore({
      env: DUMMY_ENV,
      now: clock.now,
      limits: { rateMax: 6, maxConcurrent: 1000 },
      fetchImpl: async () => ({ status: 200, body: { ok: true, path: "Delegations/opencode/op-r.md", status: "queued" } }),
    });
    const send = () => core.handleRpc({ jsonrpc: "2.0", id: Math.random(), method: "message/send", params: { message: missionMessage("Rate window probe mission") } });
    for (let i = 0; i < 6; i++) {
      const res = await send();
      assert.equal(res.httpStatus, 200, `send ${i}`);
      clock.advance(60_000);
    }
    const seventh = await send();
    assert.equal(seventh.httpStatus, 429);
    assert.match(seventh.envelope.error.message, /rate limit/);
    clock.advance(61 * 60_000); // past the whole window
    const eighth = await send();
    assert.equal(eighth.httpStatus, 200);
  });
});

// -- A6: framing adversarial matrix ----------------------------------------------------

describe("A6: HTTP framing adversarial matrix", () => {
  let app;
  before(async () => {
    const core = createBridgeCore({ env: DUMMY_ENV, fetchImpl: async () => ({ status: 200, body: { ok: true, path: "p.md", status: "queued" } }) });
    app = await listenEphemeral(core);
  });
  after(async () => closeServer(app.server));

  it("oversized body (>= 256KB) -> 413 + Connection: close", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "y".repeat(270_000) }] } } });
    const res = await rawSend(app.port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(big)}\r\n\r\n${big}`);
    assert.match(res.received, /^HTTP\/1\.1 413/);
    assert.match(res.received, /Connection: close/i);
    assert.ok(res.closed, "socket explicitly closed");
  });

  it("Content-Length over the cap -> immediate 413 without reading the body", async () => {
    const res = await rawSend(app.port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 999999999\r\n\r\n`, { timeoutMs: 3000 });
    assert.match(res.received, /^HTTP\/1\.1 413/);
  });

  it("chunked transfer-encoding -> 400 + close", async () => {
    const res = await rawSend(app.port, `POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`);
    assert.match(res.received, /^HTTP\/1\.1 400/);
    assert.ok(res.closed);
  });

  it("missing / bad Content-Length -> 400 + close", async () => {
    const missing = await rawSend(app.port, `POST / HTTP/1.1\r\nHost: x\r\n\r\n`, { timeoutMs: 3000 });
    assert.match(missing.received, /^HTTP\/1\.1 400/);
    const bad = await rawSend(app.port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: banana\r\n\r\n`, { timeoutMs: 3000 });
    assert.match(bad.received, /^HTTP\/1\.1 400/);
  });

  it("zero-length body -> 413 + close", async () => {
    const res = await rawSend(app.port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n`, { timeoutMs: 3000 });
    assert.match(res.received, /^HTTP\/1\.1 413/);
  });

  it("unknown path -> 404; GET / and GET /health -> status; POST /health -> status envelope", async () => {
    const res = await get(app.port, "/nowhere");
    assert.equal(res.status, 404);
    const root = await get(app.port, "/");
    assert.equal(root.status, 200);
    assert.equal(root.json.ok, true);
    assert.equal(root.json.a2a, "0.2.5");
    const health = await get(app.port, "/health");
    assert.equal(health.json.methods.join(","), "message/send,tasks/get,tasks/cancel");
    const tool = await postRpc2(app.port, "/health", { method: "a2abridge.status", params: {} });
    assert.equal(tool.status, 200);
    assert.equal(tool.json.ok, true);
    assert.equal(tool.json.addon, ADDON_ID);
    assert.equal(tool.json.version, ADDON_VERSION);
  });

  async function postRpc2(port, pathname, payload) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, json: await res.json() };
  }

  it("flood: 60 rapid malformed + valid requests — every one answered, server alive", async () => {
    const reqs = [];
    for (let i = 0; i < 30; i++) {
      reqs.push(postRpc(app.port, undefined, { raw: "{flood" }));
      reqs.push(postRpc(app.port, { jsonrpc: "2.0", id: i, method: "tasks/get", params: { id: "tsk_missing" } }));
      reqs.push(postRpc(app.port, { jsonrpc: "2.0", id: i, method: "message/stream", params: {} }));
    }
    const results = await Promise.all(reqs);
    for (const res of results) {
      assert.ok(res.json !== null || res.status >= 400, "answered");
      assert.ok([200, 400].includes(res.status));
    }
    const alive = await get(app.port, "/health");
    assert.equal(alive.status, 200);
  });
});

// -- 408: lying Content-Length (child process with a short deadline) -----------------

describe("A6: lying Content-Length -> 408 + close (explicit body-receipt deadline)", () => {
  it("a stalled body is answered 408 and the socket is not pinned forever", async () => {
    const stub = await createStubHost({ startDelayMs: 50 });
    const port = await freePort();
    const { child, exitCode, stderr } = await spawnService(
      { ...DUMMY_ENV, A2A_BRIDGE_TARGET_URL: stub.url, A2A_BRIDGE_REQUEST_TIMEOUT_MS: "1000" },
      port,
    );
    assert.equal(exitCode, null);
    try {
      const t0 = Date.now();
      // Announce 5000 bytes, send 10, then hold the socket open.
      const res = await rawSend(port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\n\r\n0123456789`, { timeoutMs: 6000 });
      const elapsed = Date.now() - t0;
      assert.match(res.received, /^HTTP\/1\.1 408/);
      assert.match(res.received, /Connection: close/i);
      assert.ok(elapsed >= 900 && elapsed < 5000, `408 fired on the deadline (elapsed=${elapsed}ms)`);
      assert.ok(res.closed, "socket closed after the 408");
    } finally {
      child.kill("SIGTERM");
      await stub.close();
      assert.ok(stderr.length >= 0);
    }
  });
});

// -- A8: log redaction + A3 lifecycle end-to-end over real processes ------------------

describe("A8: log redaction across a real-process lifecycle", () => {
  it("no mission, excerpt, path, or token value ever reaches the logs", async () => {
    const stub = await createStubHost({ startDelayMs: 150, homePathLeak: true });
    const port = await freePort();
    const { child, exitCode, stderr } = await spawnService(
      { ...DUMMY_ENV, A2A_BRIDGE_TARGET_URL: stub.url },
      port,
    );
    assert.equal(exitCode, null);
    try {
      const sent = await postRpc(port, { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: missionMessage(MISSION) } });
      assert.equal(sent.json.result.status.state, "submitted");
      await new Promise((r) => setTimeout(r, 400));
      await postRpc(port, { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: sent.json.result.id } });
      await new Promise((r) => setTimeout(r, 100));
      assertNoLeaks(stderr, "server stderr");
      assert.ok(stderr.includes("a2a-bridge:"), "logs present");
      assert.ok(!stderr.includes("dummy-record-write-token-B3"));
      assert.ok(!stderr.includes(NEEDLES.context));
    } finally {
      child.kill("SIGTERM");
      await stub.close();
    }
  });
});
