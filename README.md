# A2A Bridge (ResonantOS delegation) — ResonantOS add-on

Expose the ResonantOS opencode delegation as an A2A 0.2.5 JSON-RPC server on
loopback — serve-only, with operator-supplied capability tokens.

Any A2A client can submit a text mission to the local ResonantOS opencode
agent and retrieve the result artifact, using the standard A2A task
lifecycle, without touching any other ResonantOS surface. The bridge never
dials beyond 127.0.0.1. External actions remain governed by the delegation
packet's own boundary (`forbiddenActions: ... external-send`,
`approvalRequiredBeforeExternalAction: true`) — the bridge does not and
cannot weaken that.

## What it does

- `GET /.well-known/agent-card.json` — static, honest A2A agent card
  (production-reference shape: `supportedInterfaces[].protocolVersion`
  `"0.2.5"` inside the interfaces block; `streaming`/`pushNotifications`/
  `extendedAgentCard` all false). `GET`/`HEAD` only, `405` otherwise,
  ETag byte-locked by test.
- `POST /` — JSON-RPC 2.0 with a three-method allowlist:
  - `message/send` — validates the mission (8..24000 chars of joined text /
    data parts), creates a governed delegation packet in ResonantOS
    (`target: "opencode"`, `source: "a2a-bridge"`), fires the delegation
    start **without awaiting it** (the host runs the delegation to completion
    inside its start route), and answers `submitted` immediately with an
    opaque task id.
  - `tasks/get` — polls the host and maps states:
    `queued→submitted, running→working, completed→completed,
    blocked→failed (+reason), failed→failed, cancelled→canceled`. On the
    first `completed` observation the bridge fetches the artifact and
    returns it **verbatim** (`artifactRef.content`), never mutated, never
    persisted. Tasks read back as state + `artifactRef` only — no A2A
    history array, no host fields.
  - `tasks/cancel` — cancels upstream and **latches canceled locally**:
    once issued, the task is terminal-canceled even if the host later
    writes `completed` (their completion write can race a cancel; the
    latch makes that race unobservable here). Idempotent; canceling a
    completed/failed task is `-32002 Task not cancelable`.
- `message/stream` and everything else → `-32601 Method not found`.
- `GET /health` — status probe (the manifest's `a2abridge.status` tool).

## The honest limits

These are the bridge's own protective choices (in-memory, single process;
counters and the task table reset on restart — restart orphans read back as
`-32001 Task not found`):

- Body cap 256 KB (oversized → `413` + close; a >24,000-char mission in a
  legal body → `-32602`).
- One delegation in flight (`429` when busy), 6 missions per rolling hour
  (`429` with `Retry-After`).
- Task table holds the last 64 tasks; older entries are evicted and read
  back as `-32001 Task not found`.
- A task stuck in `submitted` longer than the submitted-deadline (default
  30 s) is failed explicitly rather than reporting `submitted` forever.
- Their 8-char mission **minimum** is enforced (`-32602`); their 24,000-char
  cap applies to context packets, not missions — the 24,000 mission cap here
  is ours.

Errors follow the reference wire: `-32700 Parse error` (HTTP 400, id null),
`-32600 Invalid Request` (HTTP 400, including unknown top-level fields),
`-32601`, `-32602`; `-32001/-32002` per the vendored A2A SDK. Missing or
wrong host tokens are surfaced verbatim (HTTP 401/403 mirrored, their fixed
error string in `error.message`) and **never retried**. Framing mirrors the
sibling add-ons: lying Content-Length → `408` + close (explicit body-receipt
deadline), chunked transfer-encoding → `400`, bind conflict → exit 78, a
wider-than-loopback bind or a non-loopback upstream URL is refused at
startup (`A2A_BRIDGE_TARGET_URL` accepts loopback only). Any `$HOME` path in
an outbound body or log line is redacted to `~`.

## Setup (operator-provided tokens)

Their SDK has no add-on token-injection path (no spawn/env logic in
`src/sdk/addons/`), so the bridge reads the tokens the browser-first
launcher already minted from its own environment. The bridge **fails loud at
startup** (exit 78, with these instructions) if any is missing:

```sh
export RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN=<launcher-minted bridge token>
export RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN=<addon-record-write>
export RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN=<addon-runtime-control>
export RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN=<addon-runtime-read>

node server.mjs            # http://127.0.0.1:4898 (the manifest entrypoint)
```

The values are read once at startup and are never logged, echoed, or
persisted. No capability tokens are minted or stored by the bridge — it
reuses exactly three existing host capabilities (`addon-record-write`,
`addon-runtime-control`, `addon-runtime-read`) plus the bridge token.

Dev/test overrides (all exit 78 on invalid values; the manifest declares the
contract): `A2A_BRIDGE_PORT` (default 4898),
`A2A_BRIDGE_TARGET_URL` (default `http://127.0.0.1:47773`; loopback URLs
only), `A2A_BRIDGE_REQUEST_TIMEOUT_MS` (default 30000),
`A2A_BRIDGE_SUBMITTED_DEADLINE_MS` (default 30000).

## Quick check

```sh
curl -s http://127.0.0.1:4898/.well-known/agent-card.json | shasum
curl -s http://127.0.0.1:4898/health
curl -s -X POST http://127.0.0.1:4898/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"text","text":"Report the public functions of the parser module"}]}}}'
# -> result.status.state "submitted" with an opaque tsk_... id; poll:
curl -s -X POST http://127.0.0.1:4898/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<taskId>"}}'
```

## Stranger-runs-these

```sh
git clone <repo> && cd <repo>
node --test                                              # x2, all green
bash run-validator-check.sh <path-to-2.0.0-alpha-clone>   # A1: 0 errors / 0 warnings
export RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN=...
export RESONANTOS_BROWSER_FIRST_ADDON_RECORD_WRITE_TOKEN=...
export RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN=...
export RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN=...
node server.mjs             # 127.0.0.1:4898 (exit 78 with setup help if tokens are missing)
curl -s 127.0.0.1:4898/.well-known/agent-card.json | shasum -a 256   # byte-lock
# A3 round-trip vs stub host: POST message/send -> submitted (< stub start latency)
#   -> poll tasks/get -> working -> completed + verbatim artifact
node scripts/run-matrix.mjs # full adversarial matrix (boots its own stub + server)
```

## Privacy

Externally a task is an opaque bridge-minted `tsk_...` id. Host status
responses carry home-relative paths and 360-char mission/context/result
excerpts — the bridge reads only the fields it needs (`status`,
`blockedReason`, artifact `content`); paths and excerpts never leave bridge
memory and never appear in any response or log line. Artifacts are returned
verbatim, never mutated, never persisted. The test suite asserts this with
planted needles: every response is scanned for the mission, the context, the
excerpt, and a home-relative path.

## Tests

    node --test                                              # suite (44 tests), run twice
    node scripts/run-matrix.mjs                              # live adversarial matrix on 127.0.0.1:4898
    sh run-validator-check.sh <path-to-2.0.0-alpha-clone>    # manifest vs the real validator

The suite covers: the A0 fail-loud startup (missing tokens → exit 78 with
setup instructions, token values never echoed), the agent-card byte lock,
the wire matrix (malformed JSON, non-2.0, missing id, unknown fields,
`message/stream`, unknown methods, param shapes — each code verified), the
A3 real round-trip against a stub host whose start **sleeps** (proving the
un-awaited start: `submitted` returns before the stub's start latency),
blocked/failed mapping, the A4 cancel latch (a stub that completes after the
cancel still reads canceled), A5 verbatim 401/403 without retries,
`-32001`/`-32002` task semantics, the bounded task table, the rolling rate
window and concurrency limit (injected clock), A9 drift fail-loud, framing
(413/408/chunked), flood resistance, log redaction, and deterministic
delegate-packet bytes modulo ids/timestamps.

## Attribution

- ResonantOS browser-first (2.0.0-alpha) delegation pattern — the five host
  routes, the governed delegation packet, and the capability-token scheme
  this bridge reuses (never re-mints).
- A2A task wire semantics — vendored A2A SDK as seen in kinocut (c7ce91e).
- Agent-card shape — the production A2A card reference (shape only; all
  identity content here is the bridge's own).

## License

Apache-2.0 — see LICENSE and NOTICE.
