# Cursor CLI Runtime Boundary

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Question

Is Cursor CLI ready for an ACP-first nucleus adapter?

## Sources

- Cursor CLI overview: `https://cursor.com/docs/cli/overview`
- Cursor CLI ACP docs: `https://cursor.com/docs/cli/acp`
- Agent Client Protocol overview: `https://agentclientprotocol.com/protocol/v1/overview`
- Agent Client Protocol session setup: `https://agentclientprotocol.com/protocol/v1/session-setup`
- Agent Client Protocol prompt turn: `https://agentclientprotocol.com/protocol/v1/prompt-turn`
- Agent Client Protocol tool calls: `https://agentclientprotocol.com/protocol/v1/tool-calls`
- Agent Client Protocol session modes: `https://agentclientprotocol.com/protocol/v1/session-modes`
- Agent Client Protocol session config options:
  `https://agentclientprotocol.com/protocol/v1/session-config-options`
- Agent Client Protocol transports: `https://agentclientprotocol.com/protocol/v1/transports`
- T3 Cursor ACP support:
  `external/t3code/apps/server/src/provider/acp/CursorAcpSupport.ts`
- T3 ACP session runtime:
  `external/t3code/apps/server/src/provider/acp/AcpSessionRuntime.ts`
- T3 Cursor adapter:
  `external/t3code/apps/server/src/provider/Layers/CursorAdapter.ts`
- Local Cursor Agent binary: `agent --version` returned `2026.05.01-eea359f`.

## Finding

Cursor CLI is ready for ACP adapter design.

It is not ready for implementation until the nucleus ACP runtime schema is
written and tested against a real `agent acp` session.

## Transport Boundary

Cursor CLI starts ACP-first.

Evidence:

- Cursor documents `agent acp` as the way to run Cursor CLI as an ACP server
  for custom clients.
- Cursor's ACP page describes a minimal client that spawns `agent acp`, sends
  JSON-RPC over stdin, reads updates from stdout, authenticates with
  `cursor_login`, creates `session/new`, sends `session/prompt`, renders
  `session/update`, and answers `session/request_permission`.
- ACP defines stdio as the stable transport shape. Streamable HTTP is still
  draft.
- T3 Code builds Cursor ACP spawn input as `agent acp`, with optional configured
  binary path and endpoint.
- Local machine evidence confirms `agent acp --help` exists.

The Cursor SDK is not the same adapter path. It remains a separate research
surface for cloud/programmatic workflows.

## Lifecycle Boundary

Nucleus should model Cursor ACP lifecycle as:

- spawn configured `agent acp`
- send `initialize`
- send `authenticate` with `cursor_login`
- create `session/new`
- load previous session with `session/load` when capability and persisted
  provider session id allow it
- send turns with `session/prompt`
- cancel active turn with `session/cancel`
- close the child process on adapter shutdown

ACP now also documents `session/resume`, but T3's current runtime tries
`session/load` for a persisted Cursor session id and falls back to `session/new`.
Nucleus should not assume resume support until the initialize capability says
so.

## Identity Boundary

Cursor ACP sessions provide a provider session id from `session/new`.

Nucleus must retain:

- nucleus session id
- adapter instance id
- Cursor ACP session id
- ACP JSON-RPC request id
- ACP `messageId` where supplied
- ACP `toolCallId` where supplied
- ACP permission request JSON-RPC id
- provider extension method and payload ids where supplied

ACP message ids are optional for chunks. When Cursor does not provide a stable
message id, nucleus must synthesize a session-local item id from session id,
turn id, update type, and monotonic sequence, and mark the id synthetic.

T3 uses generated assistant segment ids derived from the ACP session id and a
segment index. That is acceptable as a specimen, but nucleus should make the
synthetic/id-source flag explicit.

## Permissions And User Input

Cursor ACP sends permission requests through ACP
`session/request_permission`.

Nucleus must treat these as server-owned wait states:

- preserve permission request id
- preserve provider option ids
- expose selected/cancelled outcomes
- respond with `cancelled` on turn cancellation
- keep permission state outside the desktop client

Cursor also has Cursor-specific ACP extension methods such as ask-question and
plan/todo/task/image surfaces in the docs and T3 parser tests. These should
remain raw extension events until nucleus has enough evidence to promote them
into canonical user-input or plan events.

## Modes And Configuration

Cursor CLI exposes modes in the CLI surface:

- default agent mode
- plan mode
- ask mode

ACP has both session modes and newer session config options. ACP says config
options are preferred and dedicated mode methods are expected to be removed in a
future protocol version.

Nucleus should therefore:

- prefer config options when provided
- retain mode state where ACP still reports it
- map Cursor plan/ask/default modes as provider capabilities, not universal
  nucleus assumptions
- use model/config option ids reported by the session, not hard-coded labels

T3 follows this direction by reading config options, finding model categories,
and applying Cursor model selection through `session/set_config_option` or
`session/set_model` support.

## Local Binary Notes

Local Cursor Agent evidence:

- `agent --version`: `2026.05.01-eea359f`
- `agent acp --help`: `Start the Cursor Agent as an ACP server`
- main CLI supports `--print`, `--output-format`, `--mode`, `--plan`,
  `--resume`, `--continue`, `--model`, `--list-models`, `--sandbox`,
  `--trust`, and workspace/worktree flags

The non-ACP CLI surface is useful for automation research but should not be
mixed into the ACP adapter contract.

## Promotion

Promoted into:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/architecture/system-architecture.md`

## Remaining Gaps

- Verify Cursor's initialize response on current installed versions.
- Capture real `session/new`, `session/load`, `session/prompt`,
  `session/request_permission`, and config option payloads.
- Decide whether `session/resume` matters for Cursor once actual capabilities
  are observed.
- Decide how Cursor extension methods map to canonical nucleus plan,
  user-input, and task events.
- Keep Cursor SDK research separate from local Cursor CLI ACP research.

## Next Task

Draft adapter runtime ownership and stream semantics.
