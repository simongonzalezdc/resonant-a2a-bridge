// Stub of the browser-first bridge host (read-only reference behavior,
// cite-shaped) for the a2a-bridge test suite. Implements the five routes the
// bridge calls, with a controllable delegation timeline and failure modes.
//
// The stub deliberately plants LEAK NEEDLES in every field the bridge must
// never expose (home-relative paths, the 360-char mission/context/result
// excerpts their status summaries carry, addon-delegation-service.mjs:517-534)
// so the privacy assertions scan real shapes, not vacuous ones.
import { createServer } from "node:http";
import os from "node:os";

export const NEEDLES = Object.freeze({
  mission: "ZZMISSIONNEEDLEQ9",
  context: "ZZCONTEXTNEEDLEQ9",
  excerpt: "ZZEXCERPTNEEDLEQ9",
  artifact: "ZZARTIFACTNEEDLEQ7-verbatim-marker",
  fakePath: "/Users/zz-fake-home-needle/BrowserFirst/Delegations/opencode/op-stub-1.md",
});

export const ARTIFACT_CONTENT = [
  "# OpenCode Result: op-stub-1",
  "",
  "## Final Summary",
  `Stub result. ${NEEDLES.artifact}`,
  "",
  "## Verification",
  "- stub verification line",
  "",
].join("\n");

export async function createStubHost(options = {}) {
  const {
    startDelayMs = 400, // start holds this long before the task completes
    homePathLeak = true, // paths carry a fake /Users/... needle
    delegateMode = "ok", // ok | 401 | 403 | drift-no-path | network
    statusMode = "ok", // ok | drift-no-status | unknown-status | 401 | 403
    artifactMode = "ok", // ok | drift-no-content | 401 | 403
    holdRunning = false, // never leave "running" when true
  } = options;

  const home = os.homedir();
  const pathValue = homePathLeak ? NEEDLES.fakePath : "BrowserFirst/Delegations/opencode/op-stub-1.md";
  const state = {
    starts: 0,
    statusCalls: 0,
    artifactCalls: 0,
    cancelCalls: 0,
    delegateCalls: 0,
    startFirstByteAt: 0,
    startCompletedAt: 0,
    taskStartedAt: 0,
    cancelled: false,
    delegateBodies: [],
    delegateAuthHeaders: [],
    startAuthHeaders: [],
    statusAuthHeaders: [],
    artifactAuthHeaders: [],
    cancelAuthHeaders: [],
    bridgeTokens: [],
  };

  function summaryFor() {
    let status = "queued";
    if (state.starts > 0) {
      if (!holdRunning && Date.now() - state.taskStartedAt >= startDelayMs) status = "completed";
      else status = "running";
    }
    if (state.cancelled) status = state.starts > 0 && !holdRunning && Date.now() - state.taskStartedAt >= startDelayMs ? "completed" : "cancelled";
    const summary = {
      // The leak needles their real summaries carry (:517-534) — must never
      // appear in any bridge response or log:
      contextExcerpt: `Context packet excerpt ${NEEDLES.context} truncated at 360 chars`,
      hasContextPacket: true,
      id: "op-stub-1",
      mission: `Mission excerpt ${NEEDLES.mission} truncated at 360 chars`,
      path: pathValue,
      resultArtifactPath: pathValue.replace("op-stub-1.md", "op-stub-1-result.md"),
      resultExcerpt: `Result excerpt ${NEEDLES.excerpt} truncated at 360 chars`,
      sourceControlRunId: "",
      sourceKind: "a2a-bridge",
      status,
      target: "opencode",
      updatedAt: new Date().toISOString(),
    };
    if (options.blockedReason && status !== "completed") {
      summary.status = "blocked";
      summary.blockedReason = options.blockedReason;
    }
    return summary;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      return { raw, body: JSON.parse(raw) };
    } catch {
      return { raw, body: null };
    }
  }

  function recordAuth(req, sink) {
    sink.push(req.headers["x-resonantos-bridge-capability-token"] ?? "");
    state.bridgeTokens.push(req.headers["x-resonantos-bridge-token"] ?? "");
  }

  const server = createServer(async (req, res) => {
    const { raw, body } = await readBody(req);
    const sendJson = (code, payload) => {
      const data = JSON.stringify(payload);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    };

    if (req.method === "POST" && req.url === "/addons/delegate") {
      state.delegateCalls += 1;
      recordAuth(req, state.delegateAuthHeaders);
      if (delegateMode === "network") {
        res.destroy();
        return;
      }
      if (delegateMode === "401") {
        sendJson(401, { ok: false, error: "Unauthorized browser-first bridge request." });
        return;
      }
      if (delegateMode === "403") {
        sendJson(403, { ok: false, error: "Bridge route requires addon-record-write capability." });
        return;
      }
      state.delegateBodies.push(raw);
      if (delegateMode === "drift-no-path") {
        sendJson(200, { ok: true, id: "op-stub-1", status: "queued", target: "opencode" });
        return;
      }
      sendJson(200, {
        ok: true,
        hasContextPacket: true,
        id: "op-stub-1",
        mission: `Mission excerpt ${NEEDLES.mission}`,
        path: pathValue,
        source: "a2a-bridge",
        status: "queued",
        target: "opencode",
      });
      return;
    }

    if (req.method === "POST" && req.url === "/opencode/delegation/start") {
      state.starts += 1;
      recordAuth(req, state.startAuthHeaders);
      state.startFirstByteAt = Date.now();
      state.taskStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, startDelayMs)); // THE sleep: proves un-awaited start
      state.startCompletedAt = Date.now();
      sendJson(200, { ok: true, ...summaryFor(), status: holdRunning ? "running" : "completed", adapter: "stub" });
      return;
    }

    if (req.method === "POST" && req.url === "/opencode/delegation/status") {
      state.statusCalls += 1;
      recordAuth(req, state.statusAuthHeaders);
      if (statusMode === "401") {
        sendJson(401, { ok: false, error: "Unauthorized browser-first bridge request." });
        return;
      }
      if (statusMode === "403") {
        sendJson(403, { ok: false, error: "Bridge route requires addon-runtime-read capability." });
        return;
      }
      if (statusMode === "drift-no-status") {
        sendJson(200, { ok: true, id: "op-stub-1" });
        return;
      }
      if (statusMode === "unknown-status") {
        sendJson(200, { ok: true, ...summaryFor(), status: "mysteriously-transmogrified" });
        return;
      }
      sendJson(200, { ok: true, ...summaryFor() });
      return;
    }

    if (req.method === "POST" && req.url === "/opencode/delegation/artifact") {
      state.artifactCalls += 1;
      recordAuth(req, state.artifactAuthHeaders);
      if (artifactMode === "401") {
        sendJson(401, { ok: false, error: "Unauthorized browser-first bridge request." });
        return;
      }
      if (artifactMode === "403") {
        sendJson(403, { ok: false, error: "Bridge route requires addon-runtime-read capability." });
        return;
      }
      if (artifactMode === "drift-no-content") {
        sendJson(200, { ok: true, path: pathValue, finalSummary: "no content field" });
        return;
      }
      sendJson(200, {
        changedFiles: [],
        commandsRun: [],
        content: ARTIFACT_CONTENT,
        finalSummary: `Stub result. ${NEEDLES.artifact}`,
        path: pathValue.replace("op-stub-1.md", "op-stub-1-result.md"),
        residualRisks: [],
        verification: [],
      });
      return;
    }

    if (req.method === "POST" && req.url === "/opencode/delegation/cancel") {
      state.cancelCalls += 1;
      recordAuth(req, state.cancelAuthHeaders);
      state.cancelled = true;
      sendJson(200, { ok: true, ...summaryFor(), status: "cancelled" });
      return;
    }

    sendJson(404, { ok: false, error: "Unknown browser-first bridge route." });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    server,
    port,
    state,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
