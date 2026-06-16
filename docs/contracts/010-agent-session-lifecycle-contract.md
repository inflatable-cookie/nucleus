# 010 Agent Session Lifecycle Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the server-owned lifecycle for agent sessions before provider
implementation begins.

Agent sessions are nucleus records. Provider-native session ids are retained,
but they do not replace nucleus session ids.

## Session Identity

Each agent session must expose:

- stable nucleus session id
- adapter id
- provider instance id
- provider session id where available
- lifecycle state
- recovery state
- active turn id where available

Adapter id selects the configured adapter instance. Provider instance id binds
the session to the configured account or runtime.

## Lifecycle States

Initial lifecycle states:

- created
- attached
- running
- paused
- cancelling
- closed
- failed

Unsupported lifecycle transitions must be rejected or recorded as unsupported
capabilities. They must not silently no-op.

## Lifecycle Actions

Initial lifecycle actions:

- create
- attach
- resume
- send turn
- steer
- pause
- cancel
- interrupt
- close
- rollback
- respond to approval
- respond to user input
- recover

Adapters expose which actions are supported. The server owns the command and
state transition record.

## Turn Lifecycle

Each turn must expose:

- stable nucleus turn id
- nucleus session id
- provider turn id where available
- turn status

Initial turn statuses:

- pending
- running
- waiting for approval
- waiting for user input
- completed
- cancelled
- failed

## Recovery Rule

After restart or provider disconnect, each session must be marked as:

- not needed
- recoverable
- recovery required
- recovery failed
- unknown

Recovery state is explicit so clients can render uncertainty instead of
pretending all harnesses support resume equally.

## Task Attempt Linkage

Agent sessions may be linked from task agent attempts, but task history must not
copy session runtime event streams.

Task attempt records may retain:

- nucleus session id
- selected adapter instance reference
- selected route reference
- runtime event references
- validation references
- short attempt summary

The session lifecycle contract remains the authority for session state, turn
state, provider ids, recovery state, approvals, and user-input wait states.
Task history links to that evidence for audit and recovery.

## Codex Mapping

First-pass Codex mapping:

- nucleus session id maps to one Codex thread binding
- provider session id maps to Codex thread id
- nucleus turn id maps to Codex turn id where available
- lifecycle `Create` maps to `thread/start`
- lifecycle `Resume` maps to `thread/resume`
- lifecycle `SendTurn` maps to `turn/start`
- lifecycle `Steer` maps to `turn/steer`
- lifecycle `Interrupt` maps to `turn/interrupt`
- rollback maps to Codex thread rollback only after generated-schema
  verification

If `thread/resume` fails and an adapter starts a new thread, nucleus must record
that as recovery fallback instead of silently preserving the old session
binding.

## Cursor ACP Mapping

First-pass Cursor mapping:

- nucleus session id maps to one Cursor ACP session binding
- provider session id maps to ACP `sessionId`
- lifecycle `Create` maps to `session/new`
- lifecycle `Resume` maps to `session/load` or `session/resume` only when the
  agent advertises the relevant capability
- lifecycle `SendTurn` maps to `session/prompt`
- lifecycle `Cancel` maps to `session/cancel`
- approval wait state maps to `session/request_permission`
- model and mode updates prefer ACP session config options when available

Cursor ACP request ids, message ids, tool-call ids, and permission option ids
must be preserved. Missing ACP message ids require marked synthetic nucleus
item ids.

Cursor-specific extension requests and notifications must remain attached to
the session record until a canonical mapping is promoted.

## Claude Mapping

First-pass Claude mapping:

- nucleus session id maps to one configured Claude adapter instance session
- provider session id maps to the Claude session id reported by SDK result or
  system messages
- lifecycle `Create` maps to a new SDK query with a generated session id
- lifecycle `Resume` maps to SDK `resume` or CLI `--resume`
- lifecycle `SendTurn` maps to streaming prompt input on the active SDK query
- lifecycle `Steer` maps to enqueueing a message while a turn is active only
  when the adapter declares support
- lifecycle `Interrupt` maps to the SDK query interrupt method or owned CLI
  process interruption
- lifecycle `Close` maps to closing the SDK query and owned subprocess tree
- approval wait state maps to the SDK permission callback
- user-input wait state maps to the SDK `AskUserQuestion` callback
- provider-native rollback is unsupported until later evidence proves it

Claude recovery must record whether the session can resume by explicit session
id, continue the most recent directory session, or only recover a local nucleus
transcript projection. Session recovery is not filesystem rollback.

## Kimi ACP Mapping

First-pass Kimi mapping:

- nucleus session id maps to one configured Kimi ACP session binding
- provider session id maps to ACP `sessionId`, which matches the underlying
  Kimi session id
- lifecycle `Create` maps to `session/new`
- lifecycle `Attach` is unsupported unless a future Kimi surface exposes live
  process attachment
- lifecycle `Resume` maps to `session/resume`
- lifecycle `LoadWithReplay` maps to `session/load` and replays history through
  `session/update`
- lifecycle `SendTurn` maps to `session/prompt`
- lifecycle `Cancel` maps to `session/cancel`
- model, thinking, and mode changes map to `session/set_config_option`
- approval wait state maps to `session/request_permission`
- structured user-input wait state also maps to `session/request_permission`
  using Kimi's question option namespace

Kimi ACP tool-call identity must preserve both the raw Kimi tool-call id and
the ACP turn-prefixed id `${turnId}:${toolCallId}`. History replay may
synthesize turn ids, but the synthetic layer must be marked in nucleus event
metadata once the event schema exists.

## Pi RPC Mapping

First-pass Pi mapping:

- nucleus session id maps to one configured Pi RPC process/session binding
- provider session id maps to Pi `sessionId` from `get_state` and the session
  header UUID when available
- lifecycle `Create` maps to spawning `pi --mode rpc` and reading initial state
- lifecycle `Resume` maps to switching or continuing a known session file when
  Pi exposes that through session commands or launch configuration
- lifecycle `SendTurn` maps to `prompt`
- lifecycle `Steer` maps to `steer`
- lifecycle `Cancel` and `Interrupt` map to `abort`
- lifecycle `Close` maps to terminating the owned RPC process cleanly
- model and thinking changes map to Pi RPC model/thinking commands
- queue, compaction, retry, bash, extension UI, and command discovery remain
  explicit capability surfaces, not generic lifecycle actions
- rollback is unsupported unless a future Pi capability proves provider-native
  rollback

Pi RPC event identity must be synthesized from adapter instance id, Pi
session id, session file, RPC stream generation, monotonic stream sequence,
event type, and stable ids inside the payload such as `toolCallId`.

Pi session-file entries form a separate replay identity namespace. Their entry
ids and `parentId` tree links must be preserved, and tree branch/navigation
must not be presented as filesystem rollback.

Pi recovery must record whether nucleus can reconnect to a session file,
restart a Pi RPC process around the same session file, or only retain a
nucleus transcript projection. Sandbox state must be reported as none/external
unless nucleus owns an OS, container, or VM wrapper around the Pi process.

## Current Rust Surface

`nucleus-agent-protocol` now contains the first draft of:

- `AgentSessionId`
- `AgentTurnId`
- `AgentSessionRecord`
- `AgentSessionLifecycleState`
- `AgentSessionRecoveryState`
- `SessionLifecycleAction`
- `AgentSessionStateChange`
- `AgentTurnRecord`
- `AgentTurnStatus`
- `AdapterCommandRequest`
- `AdapterCommandAcknowledgement`

The crate is now split into focused modules for identity, capabilities, events,
routes, sessions, and adapter trait requirements.

These are descriptive lifecycle types only. Provider session creation, resume,
event ingestion, persistence, cancellation, approval handling, and process
control remain out of scope.

## Research Gaps

- Provider-specific session resume semantics beyond Codex, first-pass Cursor
  ACP, first-pass Claude SDK/CLI, first-pass Kimi ACP, and first-pass Pi RPC.
- Which lifecycle actions map cleanly across ACP, SDK, app-server, RPC, and
  CLI/PTY integrations.
- How approval and user-input responses bind to active turns.
- How session recovery integrates with the future storage backend.

## Next Task

Draft projection storage Rust surface boundaries.
