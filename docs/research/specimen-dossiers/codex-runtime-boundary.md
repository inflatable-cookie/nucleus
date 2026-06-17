# Codex Runtime Boundary

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-17

## Purpose

Record Codex transport and identity evidence for nucleus adapter readiness.

This dossier uses the current Codex manual, local CLI help, and the T3 Code
Codex integration as evidence. It does not authorize implementation yet.

## Sources

- Codex manual: `https://developers.openai.com/codex/codex-manual.md`
- App server: `https://developers.openai.com/codex/app-server`
- CLI reference: `https://developers.openai.com/codex/cli/reference`
- SDK: `https://developers.openai.com/codex/sdk`
- Non-interactive mode: `https://developers.openai.com/codex/noninteractive`
- Authentication: `https://developers.openai.com/codex/auth`
- Approvals and security:
  `https://developers.openai.com/codex/agent-approvals-security`
- T3 Code Codex adapter:
  `external/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
- T3 Code Codex session runtime:
  `external/t3code/apps/server/src/provider/Layers/CodexSessionRuntime.ts`

Local CLI evidence:

- `codex-cli 0.140.0`
- `codex app-server --help`
- `codex debug app-server send-message-v2 --help`
- `codex exec --help`
- `codex app-server generate-json-schema --out /tmp/...`
- `codex app-server generate-ts --out /tmp/...`

## Transport Decision

Codex should start structured app-server/runtime first.

Evidence:

- `codex app-server` is the documented deep integration surface for rich
  clients.
- App-server supports JSON-RPC-style messages over stdio, WebSocket, and Unix
  socket transports.
- App-server exposes thread, turn, item, approval, streamed event, and
  conversation history primitives.
- The current local CLI exposes `app-server`, schema generation, and debug
  app-server commands.
- T3 Code already wraps Codex app-server rather than a terminal-only view.

Non-interactive `codex exec --json` is useful for one-shot automation and CI,
but it is not the first nucleus adapter path because it is less suitable for
long-lived project sessions, approvals, and interactive control.

The Codex SDKs are useful evidence and possible sidecar routes. The Python SDK
controls local app-server over JSON-RPC and ships with a pinned Codex runtime.
Nucleus should still design the Rust boundary around app-server protocol
control first.

## Identity Model

Codex app-server uses:

- thread id
- turn id
- item id
- request id for client requests
- approval id or item id for some approval correlation

Nucleus mapping:

- nucleus session id maps to one Codex thread binding
- provider session id maps to Codex thread id
- nucleus turn id maps to Codex turn id where available
- provider item id maps to Codex item id
- provider request id maps to JSON-RPC request id or app-server approval id
  where available

Do not use display text or timestamps for event uniqueness.

## Lifecycle Evidence

App-server lifecycle supports:

- initialize connection
- start thread
- resume thread
- fork thread
- start turn
- steer active turn
- interrupt active turn
- stream notifications
- complete turn with final status

Current local schema generated from `codex-cli 0.140.0` verifies these client
request methods:

- `thread/read`
- `thread/rollback`
- `thread/fork`
- `thread/list`
- `thread/loaded/list`
- `thread/unsubscribe`
- `thread/compact/start`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

The generated schema also verifies server notifications for thread state, turn
state, item lifecycle, content deltas, reasoning deltas, plan updates,
command/file-change output, request resolution, token usage, warnings, errors,
and process output.

T3 Code remains useful implementation evidence for queueing, request
correlation, and process supervision, but the local generated schema is now the
implementation authority for method names.

## Approval And User Input

Official docs show Codex approvals as a first-class safety layer. App-server is
the documented surface for approvals and streamed agent events.

T3 evidence shows these app-server request paths:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`

Current local schema verifies these server request methods and adds other
surfaces that must stay explicit:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `item/permissions/requestApproval`
- `item/tool/call`
- `account/chatgptAuthTokens/refresh`
- `attestation/generate`
- deprecated `applyPatchApproval`
- deprecated `execCommandApproval`

Nucleus must surface approval and user-input requests as server-owned state.
The adapter must preserve request kind, request id, turn id, and item id where
available.

`item/tool/requestUserInput` is marked experimental in the generated schema.
Nucleus should still model it because it is visible in current schema and T3,
but the adapter must expose experimental status in capability metadata.

## Cancellation, Resume, And Recovery

Cancellation:

- app-server lifecycle documents `turn/interrupt`
- T3 uses `turn/interrupt` with thread id and active turn id

Resume:

- app-server documents `thread/resume`
- CLI documents `codex resume` and `codex exec resume`
- T3 stores a resume cursor containing Codex thread id
- generated schema says `thread/resume` can resume by thread id, history, or
  path, with precedence rules; Nucleus should prefer thread id where possible

Recovery rule:

- session recovery is recoverable only when the Codex thread id is known and
  `thread/resume` succeeds
- fallback to a fresh thread must be explicit in nucleus state, not silent
  continuation under the old session id

## Config And Auth Preflight

Codex auth supports ChatGPT sign-in and API key sign-in. CLI and IDE extension
support both. CLI credentials are cached under `CODEX_HOME` or the operating
system credential store depending on configuration.

Useful preflight checks:

- `codex --version`
- `codex doctor --json`
- `codex app-server --help`
- config validation with `--strict-config`
- auth cache or credential-store presence where available

Adapter registry must store secret references, not raw Codex credentials.

## Capability Snapshot

First-pass Codex capability posture:

| Capability | Status | Evidence |
| --- | --- | --- |
| streaming output | supported | app-server notifications and `codex exec --json` |
| tool call events | supported | app-server item events and JSONL item types |
| file edit events | supported | app-server item/file-change events |
| permission prompts | supported | approvals docs and app-server request evidence |
| cancellation | supported | `turn/interrupt` |
| checkpointing | partial | thread/fork and rollback exist, but semantics need schema proof |
| resume | supported | `thread/resume`, `codex resume`, `codex exec resume` |
| terminal rendering | supported fallback | CLI/TUI remains available |
| structured messages | supported | app-server JSON-RPC and SDKs |
| raw transcript access | partial | `thread/read` seen in T3; schema proof needed |
| model switch support | supported | CLI/config and turn params |
| account/config preflight | partial | `doctor`, auth/config docs |
| multi-instance support | partial | possible through `CODEX_HOME` and profiles |
| rollback support | partial | T3 uses `thread/rollback`; schema proof needed |
| provider-native session resume | supported | Codex thread resume |
| external server support | supported | WebSocket/Unix/stdio app-server transports |
| server-spawn support | supported | local `codex app-server` process |

## Schema Probe 2026-06-17

Probe environment:

- command path: `/opt/homebrew/bin/codex`
- version: `codex-cli 0.140.0`
- generated JSON schema outside the repo:
  `/tmp/nucleus-codex-app-server-schema/json`
- generated TypeScript bindings outside the repo:
  `/tmp/nucleus-codex-app-server-schema/ts`

No live project session was started and no generated schema files were added to
the Nucleus repo.

Verified app-server transport/help facts:

- `codex app-server` is still marked experimental.
- default transport is `stdio://`.
- supported listen values include `stdio://`, `unix://`, `unix://PATH`,
  `ws://IP:PORT`, and `off`.
- WebSocket non-loopback auth supports capability-token and signed bearer-token
  modes.
- analytics are disabled by default for app-server unless explicitly enabled.

Verified implementation-relevant method families:

- client requests: `initialize`, `thread/start`, `thread/resume`,
  `thread/fork`, `thread/read`, `thread/rollback`, `thread/list`,
  `thread/loaded/list`, `thread/unsubscribe`, `turn/start`, `turn/steer`,
  `turn/interrupt`
- server notifications: `thread/started`, `thread/status/changed`,
  `thread/closed`, `thread/tokenUsage/updated`, `turn/started`,
  `turn/completed`, `turn/diff/updated`, `turn/plan/updated`,
  `item/started`, `item/completed`, `item/agentMessage/delta`,
  `item/plan/delta`, `item/commandExecution/outputDelta`,
  `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`,
  `serverRequest/resolved`, `item/reasoning/*`, warnings, errors, and process
  output notifications
- server requests: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/tool/requestUserInput`,
  `mcpServer/elicitation/request`, `item/permissions/requestApproval`, and
  `item/tool/call`

Implementation cautions:

- generated schema includes a large v2 surface beyond the first Nucleus
  adapter target; the first implementation should whitelist the subset above
  rather than trying to support all methods
- `item/tool/requestUserInput` is experimental
- deprecated approval methods are present and should not be first-path APIs
- `thread/rollback` returns lossy thread items and must not be confused with
  filesystem rollback
- app-server remains experimental, so registry metadata should expose protocol
  schema version/probe evidence rather than hard-code permanent guarantees

## Readiness Result

Codex is ready for a first adapter design, but not implementation in this
batch.

Implementation may now proceed to metadata-only registry descriptors and
static lifecycle/event fixtures using the 2026-06-17 generated schema as the
current evidence baseline.

## Stop Conditions Cleared

- Structured app-server path avoids terminal scraping as the primary route.
- Thread, turn, item, and request identities exist.
- Approval and user-input requests can be modeled as server-owned state.
- Resume and interruption have documented app-server/CLI support.

## Remaining Risks

- App-server is documented as a development/debugging integration surface and
  may change.
- WebSocket transport is experimental and unsupported; stdio or Unix socket
  should be first.
- The first implementation must whitelist a supported method subset from the
  generated schema rather than mirror the full app-server surface.
- Multi-instance behavior through `CODEX_HOME`, profiles, and auth stores must
  be tested before implementation.

## Promotion Targets

Promoted into:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/architecture/system-architecture.md`
