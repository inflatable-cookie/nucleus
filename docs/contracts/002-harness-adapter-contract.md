# 002 Harness Adapter Contract

Status: draft
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the planned boundary for communication with coding-agent harnesses.

This contract has a first T3 Code source pass and an expanded harness/provider
candidate pass. It remains draft until upstream docs are compared deeply enough
to design Rust traits.

## Adapter Identity

Each adapter must expose:

- stable adapter id
- provider driver kind
- provider instance id
- provider name
- harness name
- transport family
- version discovery method where available
- authentication preflight where available

Provider driver kind and provider instance id are separate concepts.

- driver kind selects the implementation package
- instance id is the durable routing key for configured accounts or runtimes

Threads, sessions, and events must bind to instance ids, not only driver kinds.

## Transport Families

Supported planned families:

- SDK
- ACP stdio
- ACP HTTP/WebSocket
- Wire stdio
- RPC stdio
- structured app-server/runtime
- server SDK over HTTP
- CLI terminal bridge
- custom provider-specific bridge

Adapters must report their transport family instead of hiding it.

First-pass provider defaults:

| Harness | Initial transport posture | Reason |
| --- | --- | --- |
| Codex | structured app-server/runtime first | T3 wraps a typed Codex app-server runtime with turn, approval, read, and rollback support. |
| Claude | SDK sidecar first; CLI/PTY fallback | Official Agent SDK exposes structured streaming, permissions, resume, and subprocess hosting. CLI remains required for fallback and terminal-native rendering. |
| Cursor CLI | ACP stdio first | Cursor documents `agent acp`; T3 spawns it and local binary help confirms it. |
| Cursor SDK | TypeScript SDK sidecar or cloud/programmatic route | SDK is distinct from local CLI/ACP harness control. |
| OpenCode | server SDK first, ACP in scope | T3 uses `@opencode-ai/sdk/v2` against local or external OpenCode server; public ACP still needs comparison. |
| Kimi CLI | ACP stdio first | Kimi documents `kimi acp` and ACP-compatible editor setup. |
| Kimi Agent SDK | SDK sidecar possible | SDKs expose CLI runtime events, approvals, turns, and sessions. |
| Pi | RPC first | Pi documents JSON RPC over stdio; SDK is richer but Node-bound. |

## Session Lifecycle

Each adapter must define how it handles:

- create session
- attach to session
- resume session
- load/replay session where supported
- send turn
- steer active turn where supported
- pause session where supported
- cancel active work
- interrupt active turn
- close session
- list active sessions
- check session ownership
- read thread/session snapshot
- rollback thread/session state where supported
- respond to approval request
- respond to structured user-input request
- recover after server restart

Unsupported lifecycle actions must be explicit capabilities, not runtime
surprises.

## Message and Event Identity

Every event emitted into nucleus must have stable identity.

Required identity fields will be specified after research, but the contract must
cover:

- nucleus event id
- provider driver kind
- provider instance id
- provider session id if available
- nucleus session id
- provider message id if available
- nucleus message id
- turn id
- item id
- request id
- provider turn id if available
- provider item id if available
- provider request id if available
- event sequence
- parent/causal relationship where available

Adapters must not rely on display text or timestamps alone for uniqueness.

When provider ids are absent, adapters must synthesize nucleus ids from a
monotonic session-local sequence plus stable contextual inputs. Synthetic ids
must be marked as synthetic in event metadata once the Rust event schema exists.

## Runtime Event Model

Adapters emit canonical runtime events into nucleus.

The event model must cover at least:

- session started/configured/state changed/exited
- thread started/state changed/metadata updated
- turn started/completed/aborted
- assistant/user message item lifecycle
- reasoning and plan updates
- content deltas
- tool call lifecycle
- command execution events
- file change events
- permission and approval requests
- structured user-input requests
- token usage updates where available
- runtime warnings/errors

Raw provider payloads may be retained for diagnostics, but UI and orchestration
must consume canonical events.

## Current Rust Surface

`nucleus-agent-protocol` now contains the first draft of:

- `AdapterIdentity`
- `ProviderDriverKind`
- `TransportFamily`
- `AdapterCapabilities`
- `CapabilitySupport`
- `RuntimeEventIdentity`
- `RuntimeEventKind`
- `RuntimeEventPayload`
- `RuntimeEventSource`
- `SessionPayload`
- `TurnPayload`
- `MessageItemPayload`
- `ReasoningPayload`
- `ContentDeltaPayload`
- `ToolCallPayload`
- `CommandExecutionPayload`
- `FileChangePayload`
- `ApprovalPayload`
- `UserInputPayload`
- `TokenUsagePayload`
- `RuntimeDiagnosticPayload`
- `ProviderExtensionPayload`
- `RawProviderPayload`
- `AdapterRuntimeOwnership`
- `AdapterRuntimeOwnershipMode`
- `RuntimeProcessOwner`
- `CommandStreamSemantics`
- `CommandAcknowledgementSemantics`
- `CommandCompletionSemantics`
- `EventStreamSemantics`
- `EventOrderingSemantics`
- `DisconnectSemantics`
- `BackpressurePolicy`
- `BackpressureOverflow`
- `RuntimeRecoveryPolicy`
- `RecoveryAction`
- `AdapterCommandStreamState`
- `AdapterEventStreamState`
- `AdapterCommandState`
- `AdapterRuntimeMetadata`
- `AdapterLifecycleBoundary`
- `AdapterEventBoundary`
- `AdapterTraitCapabilities`
- `LifecycleActionSupport`
- `EventIdentityPolicy`
- `SyntheticIdPolicy`
- `IdentityNamespace`
- `TerminalFallbackPolicy`
- `AdapterCommandRequest`
- `AdapterCommandAcknowledgement`
- `AdapterRuntimeEvent`
- `AgentSessionId`
- `AgentSessionRecord`
- `AgentSessionLifecycleState`
- `AgentTurnRecord`
- `AgentTurnStatus`

These are descriptive boundary, lifecycle, and payload types only. The first
trait split, canonical payload families, and runtime ownership semantics are
now named, but provider implementations, process spawning, stream parsing,
network clients, sidecar protocols, and async runtime behavior remain out of
scope.

## Adapter Trait Split

First Rust trait split:

- `AdapterRuntimeMetadata` exposes identity, grouped trait capabilities, model
  routes, event identity policy, and terminal fallback policy.
- `AdapterLifecycleBoundary` exposes supported lifecycle actions and the
  provider method names they map to where known.
- `AdapterEventBoundary` exposes canonical event kinds an adapter may emit.

The split is intentionally small:

- identity and capability discovery are read-only metadata
- lifecycle command execution is separate from event ingestion
- model routes remain route metadata, not adapter identity
- terminal fallback is explicit and does not replace structured events
- provider-specific extension commands stay visible as capabilities instead of
  becoming hidden generic lifecycle actions

Command envelopes are planned as `AdapterCommandRequest` and
`AdapterCommandAcknowledgement`. Runtime events are planned as
`AdapterRuntimeEvent`, carrying `RuntimeEventIdentity`, `RuntimeEventKind`, and
`RuntimeEventPayload`.

## Runtime Event Payload Schema

Canonical payload families:

- session/thread state and metadata
- turn state
- message item
- reasoning and plan updates
- content deltas
- tool calls
- command execution
- file changes
- approval requests
- structured user input
- token usage
- warnings and errors
- provider extension events

Payload rules:

- every payload records whether it came from live stream, replay, or projection
- raw provider payloads may be retained for diagnostics
- clients must not depend on raw provider payloads for core UI or orchestration
- approval requests and structured user-input requests are separate payload
  families
- command execution is separate from tool-call lifecycle
- replayed transcript entries must not pretend to be live stream events
- terminal-only adapters may emit diagnostic or provider-extension payloads
  without pretending structured message payloads exist

## Runtime Ownership And Streams

Runtime ownership modes:

- external server
- nucleus-owned local server
- SDK sidecar
- ACP stdio process
- Wire stdio process
- RPC stdio process
- PTY process
- unavailable/unknown

Ownership rules:

- ownership mode is independent of provider driver kind
- external servers are reached but not process-owned by nucleus
- nucleus-owned local servers and stdio/PTY processes are child runtime
  resources owned by the server
- SDK sidecars are explicit runtime boundaries, not hidden implementation
  details
- remote control-plane access is not adapter runtime ownership

Stream rules:

- command acknowledgement means accepted or rejected, not completed
- command completion is reported by provider response, runtime event,
  transcript projection, or unsupported/unknown semantics
- event streams must expose ordering semantics
- disconnects must surface through explicit events, process exit status,
  transport error, external health probe, or unknown semantics
- backpressure is a declared policy before async implementation exists
- recovery policy must distinguish reconnecting an external server, respawning
  an owned runtime, reattaching a session, manual recovery, unsupported, and
  unknown

## Registry Boundary

Adapter selection belongs to the adapter registry, not to the harness adapter
contract.

Adapters expose identity, routes, capabilities, lifecycle support, runtime
ownership, and event boundaries. The registry decides which configured adapter
instance receives work for a project, task, session, model route, or explicit
user choice.

This keeps provider behavior separate from deployment configuration. The same
driver may have many configured instances with different accounts, server URLs,
binary paths, secret references, runtime ownership, or project overrides.

## Native Harness Boundary

Native Nucleus harnesses are not bridged provider adapters.

They should reuse compatible session, event, capability, and audit concepts
where useful, but they must remain clearly identified as app-owned runtimes.
Their authority comes from Nucleus policy and server services.

## Credential Boundary

Harness adapters must not expose raw secret material through adapter metadata,
runtime events, control-plane responses, or audit records.

Adapters may receive resolved secret material only at the runtime boundary
declared by the registry: server-only use, owned process environment, owned
process stdin, SDK sidecar, external server request, or host credential
provider only.

Provider-native auth state belongs to the provider tool or host credential
system. Nucleus may reference it and probe it, but must not copy it into
registry records.

## Capability Discovery

Adapters must expose capabilities for:

- streaming output
- tool call events
- file edit events
- permission prompts
- cancellation
- checkpointing
- resume
- terminal rendering
- structured messages
- raw transcript access
- model switch support
- account/config preflight
- multi-instance support
- rollback support
- provider-native session resume
- lifecycle command support
- event stream support
- approval support
- structured user-input support
- extension command support
- terminal fallback support
- external server support
- server-spawn support

Capabilities must be per instance. Two instances of the same driver may differ
by binary path, environment, server URL, auth state, or provider version.

## Provider Notes

### Codex

Codex starts app-server-first.

First-pass evidence:

- `codex app-server` supports JSON-RPC-style app-server control over stdio,
  WebSocket, and Unix socket transports.
- app-server exposes thread, turn, item, streamed notification, approval, and
  user-input primitives.
- `codex exec --json` is useful for one-shot automation, but is not the first
  long-lived project adapter route.
- T3 Code uses app-server methods including `thread/start`, `thread/resume`,
  `turn/start`, `turn/interrupt`, `thread/read`, `thread/rollback`, approval
  decisions, and user-input answers.

Initial adapter requirements:

- prefer stdio or Unix socket before WebSocket
- preserve Codex thread id as provider session id
- preserve Codex turn id, item id, and request/approval ids
- surface command approval, file-change approval, and user-input requests as
  server-owned state
- treat thread resume failure and fallback-to-new-thread as explicit recovery
  state
- verify method and notification shape against generated app-server schema
  before implementation

### Claude

Claude starts SDK-sidecar-first, with direct CLI and PTY fallback paths kept
explicit.

First-pass evidence:

- the official TypeScript Agent SDK exposes structured streaming messages,
  streaming input, permission callbacks, session resume, interruption, and
  in-session model/permission controls
- the SDK supervises a `claude` subprocess and local transcript state, so it
  fits the nucleus server-owned process model rather than a stateless API model
- the CLI exposes interactive, print, JSON, stream-JSON, resume, continue,
  fork, session-id, permission, tool allow/deny, MCP, model, and effort flags
- T3 Code uses the SDK and preserves provider refs for session ids, SDK UUIDs,
  tool-use ids, permission callback ids, and structured user-input requests

Initial adapter requirements:

- run Claude through a narrow sidecar protocol unless a Rust-native supported
  SDK appears
- record sidecar version, Claude binary path, config/home path, working
  directory, setting sources, environment refs, model, effort, permission mode,
  additional directories, and MCP config
- preserve Claude session id, resume id, SDK message UUIDs, assistant message
  ids, tool-use ids, permission request ids, and structured user-input ids
- expose permission modes as capabilities: default, dontAsk, acceptEdits,
  bypassPermissions, plan, and auto
- require explicit server policy before enabling bypass permissions
- treat rollback as unsupported provider-native until upstream evidence proves
  otherwise
- treat PTY rendering as terminal fallback, not as structured message identity
  unless a parallel structured stream exists

### Cursor

Cursor CLI should start ACP-first.

Required adapter support:

- spawn configured `agent acp` command over stdio
- initialize client capabilities
- authenticate with `cursor_login`
- create `session/new`
- load or resume by provider session id only when the initialize capabilities
  allow it
- send turns with `session/prompt`
- cancel active turns with `session/cancel`
- preserve ACP request ids, session ids, message ids, tool call ids, and
  permission request ids
- synthesize marked session-local item ids when ACP messages omit stable ids
- prefer ACP session config options over legacy mode methods
- map Cursor plan/ask/default modes as provider capabilities
- handle ACP permission requests as server-owned wait states
- keep elicitation/user-input and Cursor extension methods as explicit
  extension events until promoted
- apply model/config options using reported config ids
- retain ACP extension events separately from core ACP events

The Cursor SDK remains a separate research path for cloud or programmatic
agent workflows. The non-ACP Cursor CLI/headless surface is also separate from
the ACP adapter path.

### Kimi

Kimi Code starts ACP-first.

Wire and SDK sidecar remain second paths if ACP lacks event identity or
approval fidelity.

First-pass ACP evidence:

- `kimi acp` is JSON-RPC over stdio with a clean stdout channel and logs on
  stderr
- `initialize` advertises auth methods and agent capabilities
- `session/new`, `session/load`, `session/resume`, `session/list`,
  `session/prompt`, `session/cancel`, `session/set_mode`, and
  `session/set_config_option` are implemented
- `session/load` replays history; `session/resume` does not
- `session/update` covers agent message chunks, tool calls, plans, config
  option updates, and available command updates
- `session/request_permission` covers tool approvals and question elicitation
- file read/write reverse RPC is implemented
- terminal reverse RPC is not connected; shell commands execute locally
- ACP client MCP servers are forwarded for HTTP, SSE, and stdio transports

Adapter requirements:

- spawn configured `kimi acp` command over stdio
- authenticate through the advertised terminal login method
- create, load, resume, list, prompt, cancel, and configure sessions through
  ACP
- preserve ACP JSON-RPC request ids
- preserve Kimi session id as provider session id
- preserve raw tool-call ids and the turn-prefixed ACP tool-call ids
- preserve approval option ids and question option ids
- treat history replay as a `session/load` behavior, not generic resume
- expose thinking/model/mode configuration through ACP config options
- forward MCP server configuration for supported transports
- report terminal reverse-RPC as unsupported for Kimi ACP until connected
- avoid YOLO/auto-approve as default

### Pi

Pi starts RPC-first.

Known RPC capabilities:

- strict JSONL over stdin/stdout
- request/response correlation ids for commands
- streamed events without event ids
- prompt, steer, follow-up, model, thinking, queue, compaction, retry, bash,
  session, and command discovery commands
- event stream covering agent, turn, message, tool execution, queue,
  compaction, retry, and extension errors
- JSONL session files with UUID session header and tree entries

Adapter requirements:

- synthesize event ids from adapter instance id, Pi session id, session file,
  RPC stream generation, monotonic stream sequence, event type, and stable
  provider-native ids inside the payload
- treat command request ids as request/response correlation only, not event ids
- retain Pi session id, session file path, and live RPC process generation
- preserve Pi tool-call ids and session-file entry ids when present
- keep live stream event ids separate from replayed session-file entry ids
- expose session tree, fork, branch, and navigation capabilities separately
  from rollback
- expose queue, retry, compaction, bash, extension UI, and command discovery as
  explicit capabilities
- expose loaded extension/command surfaces where possible
- report sandbox status as none/external unless nucleus wraps the process

### Model And Routing Providers

GLM/Z.ai, MiniMax, DeepSeek, OpenRouter, and OpenCode Zen are not harness
adapters by default.

They belong to a lower model/provider route layer unless a surrounding harness
exposes sessions, tools, approvals, and runtime events.

Route metadata is defined in `004-model-routing-contract.md`.

Harness adapters may expose model-route configuration, but route identity must
not replace provider instance identity.

### OpenCode

OpenCode starts server/SDK-first, with ACP kept in scope as a second transport
path.

Required adapter support:

- connect to external server URL
- spawn scoped local server when no server URL is provided
- detect server-ready output
- create SDK client for base URL and directory
- track OpenCode session id
- subscribe to server events
- preserve message ids, part ids, tool call ids, permission request ids, and
  question request ids
- map permission requests and question requests as separate wait states
- support abort, read, rollback/revert, and diff where available
- expose fork/share/revert/unrevert as explicit capabilities before use
- keep server ownership mode visible: external or nucleus-owned scoped local
  server
- treat `opencode acp` as an alternate ACP adapter path, not the same runtime
  transport as server/SDK

OpenCode model ids use `provider/model`. Model selection must stay bound to
the configured OpenCode adapter instance id. OpenCode Zen and OpenRouter are
OpenCode provider/model routes unless another harness uses them directly.

## CLI Terminal Bridge

CLI-backed adapters are valid when a provider does not expose a stable SDK or
protocol.

They must be managed as process/session resources:

- controlled launch command
- working directory
- environment
- PTY lifecycle
- terminal output stream
- input injection boundary
- exit status
- restart/recovery behavior

Terminal rendering may be the preferred UI for these providers, but process
ownership remains with the server.

## State Recovery

Adapters must document what can be recovered after:

- client disconnect
- server restart
- harness process exit
- repo path movement
- network interruption

Remote access is not an adapter concern. It belongs to server environment and
access-endpoint modeling. The adapter sees the execution environment it runs
inside.

## Research Gaps

- Cursor SDK identity and lifecycle model.
- Claude SDK sidecar protocol shape and deployment constraints.
- Claude direct CLI fallback event identity limits.
- Codex CLI session persistence and external control model.
- OpenCode ACP event identity.
- ACP remote transport maturity.
- Rust-native integration path for TypeScript-only SDKs.
- Durable synthetic id scheme for providers with missing/unstable ids.
- Exact control-plane API contract between clients and nucleus server.
- Cursor CLI headless/API surface beyond ACP.
- Real Cursor ACP initialize/session/config payloads from current installed
  versions.
- OpenCode SDK generated event schema and Rust bridge shape.
- Kimi CLI and Kimi Agent SDK lifecycle and identity model.
- Runtime event payload schemas.
- Concrete async execution and backpressure implementation.
- Sidecar protocol shape for TypeScript-only SDK integrations.
- Project and session model-route override semantics.

## Next Task

Research Nucleus native harness and steward runtime semantics.
