#!/usr/bin/env node
// Live adversarial matrix for addon.a2a-bridge (PRD publish gate).
//
// Boots the stub host + the REAL server.mjs on the manifest port 4898 with
// operator-style env, then fires the full adversarial matrix and privacy
// scans against live HTTP. Exit 0 only when every line passes.
//
// Usage: node scripts/run-matrix.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStubHost, NEEDLES } from "../tests/stub-host.mjs";

const ADDON_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4898;
const BASE = `http://127.0.0.1:${PORT}`;

const DUMMY_ENV = {
  RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN: "matrix-bridge-token",
  RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN: "matrix-record-write-token",
  RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN: "matrix-runtime-control-token",
  RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN: "matrix-runtime-read-token",
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function rawSend(raw, { timeoutMs = 8000, settleMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1");
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
      if (received.length - bodyStart >= length) setTimeout(done, settleMs);
    });
    socket.on("close", () => { closed = true; done(); });
    socket.on("error", (err) => { if (!settled) reject(err); });
    socket.on("connect", () => socket.write(raw));
  });
}

async function post(body, { raw } = {}) {
  const res = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* framing */ }
  return { status: res.status, text, json };
}

async function waitForPort(port, { timeoutMs = 15000 } = {}) {
  for (let i = 0; i < timeoutMs / 100; i++) {
    try {
      const res = await fetch(`${BASE.replace(String(PORT), String(port))}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const allResponses = [];

async function main() {
  const stub = await createStubHost({ startDelayMs: 400 });

  const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
    env: { ...process.env, ...DUMMY_ENV, A2A_BRIDGE_TARGET_URL: stub.url },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  try {
    check("server boots on manifest port 4898", await waitForPort(PORT));

    // -- card byte lock (live) ----------------------------------------------
    const card = await fetch(`${BASE}/.well-known/agent-card.json`);
    const cardText = await card.text();
    const sha = createHash("sha256").update(cardText).digest("hex");
    check("A2 card byte-lock (sha256 pinned)", sha === "639f8ed2c965298dd05107049d805704c8aae6dd8a58fa1633a3a694e69a4b5b", sha.slice(0, 16));
    const cardLower = cardText.toLowerCase();
    check("A2 card carries no PuenteWorks identity", !["puenteworks", "kinocut", "service guide"].some((s) => cardLower.includes(s)));
    allResponses.push(["card", cardText]);

    // -- JSON-RPC code matrix -------------------------------------------------
    const parse = await post(undefined, { raw: "{nope" });
    check("-32700 Parse error + HTTP 400 + id null", parse.status === 400 && parse.json?.error?.code === -32700 && parse.json?.id === null);
    allResponses.push(["parse", parse.text]);

    const invalid = await post({ jsonrpc: "1.0", id: 1, method: "tasks/get", params: { id: "x" } });
    check("-32600 Invalid Request + HTTP 400", invalid.status === 400 && invalid.json?.error?.code === -32600);
    allResponses.push(["invalid", invalid.text]);

    const stream = await post({ jsonrpc: "2.0", id: 2, method: "message/stream", params: { message: { parts: [{ kind: "text", text: "hello stream" }] } } });
    check("message/stream -> -32601", stream.json?.error?.code === -32601 && stream.status === 200);
    allResponses.push(["stream", stream.text]);

    const unknown = await post({ jsonrpc: "2.0", id: 3, method: "totally/unknown", params: {} });
    check("unknown method -> -32601", unknown.json?.error?.code === -32601);
    allResponses.push(["unknown", unknown.text]);

    const noParts = await post({ jsonrpc: "2.0", id: 4, method: "message/send", params: {} });
    check("message/send without message.parts -> -32602", noParts.json?.error?.code === -32602 && noParts.json?.error?.message === "Invalid params: message.parts is required");
    allResponses.push(["noParts", noParts.text]);

    const noText = await post({ jsonrpc: "2.0", id: 5, method: "message/send", params: { message: { parts: [{ kind: "data", data: "scalar-not-object" }] } } });
    check("no text/data part -> -32602", noText.json?.error?.code === -32602 && noText.json?.error?.message === "Invalid params: a text or data part is required");
    allResponses.push(["noText", noText.text]);

    const shortMission = await post({ jsonrpc: "2.0", id: 6, method: "message/send", params: { message: { parts: [{ kind: "text", text: "tiny" }] } } });
    check("<8-char mission -> -32602 (their :281 minimum)", shortMission.json?.error?.code === -32602);
    allResponses.push(["short", shortMission.text]);

    const bigMission = await post({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { parts: [{ kind: "text", text: "z".repeat(24_001) }] } } });
    check(">24k mission in legal body -> -32602", bigMission.json?.error?.code === -32602);
    allResponses.push(["big", bigMission.text]);

    // -- framing ---------------------------------------------------------------
    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "message/send", params: { message: { parts: [{ kind: "text", text: "w".repeat(270_000) }] } } });
    const over = await rawSend(`POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(oversized)}\r\n\r\n${oversized}`);
    check(">256KB body -> 413 + Connection: close + closed", /^HTTP\/1\.1 413/.test(over.received) && /Connection: close/i.test(over.received) && over.closed);
    allResponses.push(["413", over.received]);

    const lying = await rawSend(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\n\r\nonly-a-little`, { timeoutMs: 40000 });
    check("lying Content-Length -> 408 + close", /^HTTP\/1\.1 408/.test(lying.received) && lying.closed);
    allResponses.push(["408", lying.received]);

    const chunked = await rawSend(`POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`);
    check("chunked -> 400", /^HTTP\/1\.1 400/.test(chunked.received));

    // -- flood ------------------------------------------------------------------
    const flood = [];
    for (let i = 0; i < 40; i++) {
      flood.push(post(undefined, { raw: "{flood" }));
      flood.push(post({ jsonrpc: "2.0", id: i, method: "tasks/get", params: { id: "tsk_ghost" } }));
    }
    const floodResults = await Promise.all(flood);
    const allAnswered = floodResults.every((r) => r.json !== null && [200, 400].includes(r.status));
    const health = await fetch(`${BASE}/health`);
    check("flood (80 rapid) — every request answered, server alive", allAnswered && health.ok);

    // -- real round trip (A3 shape, live) ----------------------------------------
    const sent = await post({ jsonrpc: "2.0", id: 10, method: "message/send", params: { message: { kind: "message", messageId: "mx1", role: "user", contextId: "ctx-live-1", parts: [{ kind: "text", text: "Live matrix round trip mission text" }] } } });
    const taskId = sent.json?.result?.id;
    check("message/send -> submitted (opaque tsk_ id, contextId echoed)", sent.json?.result?.status?.state === "submitted" && /^tsk_/.test(taskId) && sent.json.result.contextId === "ctx-live-1");
    allResponses.push(["send", sent.text]);

    const cancel = await post({ jsonrpc: "2.0", id: 11, method: "tasks/cancel", params: { id: taskId } });
    check("tasks/cancel -> canceled", cancel.json?.result?.status?.state === "canceled");
    allResponses.push(["cancel", cancel.text]);

    await new Promise((r) => setTimeout(r, 700)); // stub completes after the cancel
    const after = await post({ jsonrpc: "2.0", id: 12, method: "tasks/get", params: { id: taskId } });
    check("A4 latch: host completed after cancel, bridge still reports canceled", after.json?.result?.status?.state === "canceled");
    allResponses.push(["after", after.text]);

    const sent2 = await post({ jsonrpc: "2.0", id: 13, method: "message/send", params: { message: { kind: "message", messageId: "mx2", role: "user", parts: [{ kind: "text", text: "Live matrix artifact mission text" }] } } });
    const taskId2 = sent2.json.result.id;
    let final = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      final = await post({ jsonrpc: "2.0", id: 14, method: "tasks/get", params: { id: taskId2 } });
      allResponses.push(["poll", final.text]);
      if (final.json?.result?.status?.state === "completed") break;
    }
    check("A3 lifecycle reaches completed with verbatim artifact", final?.json?.result?.artifactRef?.content?.includes(NEEDLES.artifact) === true);

    // -- excerpt needles in RESPONSES --------------------------------------------
    let leak = "";
    for (const [where, text] of allResponses) {
      for (const needle of [NEEDLES.mission, NEEDLES.context, NEEDLES.excerpt, NEEDLES.fakePath, "/Users/", os.homedir(), "matrix-record-write-token", "matrix-bridge-token"]) {
        if (text.includes(needle)) leak += `${where}:${needle.slice(0, 24)} `;
      }
    }
    check("privacy: no path/excerpt/token needles in any response", leak === "", leak);

    // -- bind conflict 78 -----------------------------------------------------------
    const conflict = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
      env: { ...process.env, ...DUMMY_ENV, A2A_BRIDGE_TARGET_URL: stub.url },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const conflictCode = await new Promise((resolve) => {
      let err = "";
      conflict.stderr.on("data", (d) => { err += d.toString(); });
      conflict.on("exit", (code) => resolve({ code, err }));
    });
    check("bind conflict -> exit 78", conflictCode.code === 78, conflictCode.err.split("\n")[0] ?? "");

    // -- A0 fail-loud (no tokens) ------------------------------------------------------
    const noTokens = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
      env: { ...process.env, A2A_BRIDGE_TARGET_URL: stub.url },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const noTokensResult = await new Promise((resolve) => {
      let err = "";
      noTokens.stderr.on("data", (d) => { err += d.toString(); });
      noTokens.on("exit", (code) => resolve({ code, err }));
    });
    check("A0: missing tokens -> exit 78 with setup instructions", noTokensResult.code === 78 && noTokensResult.err.includes("RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN"));

    // server log privacy
    for (const needle of [NEEDLES.mission, NEEDLES.context, NEEDLES.excerpt, "/Users/", os.homedir(), "matrix-bridge-token"]) {
      if (stderr.includes(needle)) {
        check("privacy: server logs clean", false, needle.slice(0, 24));
        leak = "x";
        break;
      }
    }
    if (leak !== "x") check("privacy: server logs clean", true);
  } finally {
    child.kill("SIGTERM");
    await stub.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} matrix checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("matrix crashed:", err);
  process.exit(1);
});
