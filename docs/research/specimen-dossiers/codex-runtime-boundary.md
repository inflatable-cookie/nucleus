# Codex Runtime Boundary

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

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

- `codex-cli 0.139.0`
- `codex app-server --help`
- `codex debug app-server send-message-v2 --help`
- `codex exec --help`

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

T3 Code also uses:

- `thread/read`
- `thread/rollback`
- `turn/interrupt`
- `item/requestApproval/decision`
- `item/tool/requestUserInput/answered`

These methods are implementation evidence from T3 and must be verified against
generated app-server schema before nucleus implements them.

## Approval And User Input

Official docs show Codex approvals as a first-class safety layer. App-server is
the documented surface for approvals and streamed agent events.

T3 evidence shows these app-server request paths:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`

Nucleus must surface approval and user-input requests as server-owned state.
The adapter must preserve request kind, request id, turn id, and item id where
available.

## Cancellation, Resume, And Recovery

Cancellation:

- app-server lifecycle documents `turn/interrupt`
- T3 uses `turn/interrupt` with thread id and active turn id

Resume:

- app-server documents `thread/resume`
- CLI documents `codex resume` and `codex exec resume`
- T3 stores a resume cursor containing Codex thread id

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

## Readiness Result

Codex is ready for a first adapter design, but not implementation in this
batch.

Implementation must first generate and inspect the app-server schema from the
local Codex binary, then pin the exact method and notification set nucleus will
support.

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
- Some methods used by T3 need generated-schema verification.
- Multi-instance behavior through `CODEX_HOME`, profiles, and auth stores must
  be tested before implementation.

## Promotion Targets

Promoted into:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/architecture/system-architecture.md`

## Next Task

Draft adapter secret reference and credential boundary semantics.
