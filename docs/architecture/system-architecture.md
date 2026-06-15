# System Architecture

Status: draft
Owner: Tom
Updated: 2026-06-15
Vision refs: `docs/vision/001-nucleus-product-vision.md`

## Top-Level Stack

Nucleus is server-first.

The Rust server is the system core. It owns durable state, project identity,
task state, agent sessions, workspace state, and harness process lifecycle.

The first client is a Tauri desktop app. It is a control plane over the server,
not the authority for project, task, workspace, or agent state.

Future clients may include:

- web interface
- mobile app
- CLI
- local network control plane
- internet-facing remote control plane

## Core Crate Boundaries

- `nucleus-core`: first draft persistence domains, record identity, revision,
  snapshot, and journal vocabulary.
- `nucleus-agent-protocol`: first draft adapter identity, capability, runtime
  event, model route, and agent session lifecycle types.
- `nucleus-agent-adapters`: first draft adapter registry, instance
  configuration, readiness, lifecycle, and health types.
- `nucleus-projects`: durable project identity, repo membership, and project
  lifecycle later.
- `nucleus-tasks`: task model, importance scoring, and task action taxonomy
  later.
- `nucleus-workspaces`: persisted layouts, terminals, browser views, and
  panel/tab state later.
- `nucleus-server`: first draft server authority, deployment, client, command,
  and event boundary types.

Crates expose descriptive type surfaces only. The workspace exists to make the
intended boundaries visible before implementation.

## Data and Authority Flow

The server is authoritative for:

- projects
- repo membership and path history
- tasks and importance metrics
- agent session records
- workspace layouts
- terminal and browser attachment state
- harness process lifecycle

Clients send commands and render state. They may cache for responsiveness, but
must reconcile with server state.

Remote deployment is modeled above the adapter layer.

- execution environment: one running nucleus server
- access endpoint: one concrete way for a client to reach that server
- control plane: desktop, web, mobile, or CLI client

The server owns providers, terminals, filesystem, git, project state, task
state, and workspace state. Clients select an access path; they do not split
the runtime.

## Harness Adapter Layer

Agent integrations sit behind a stable Rust protocol layer.

Supported adapter transport families:

- SDK
- ACP over stdio
- ACP over HTTP/WebSocket
- structured app-server/runtime
- server SDK over HTTP
- CLI terminal bridge
- custom provider-specific bridge

Provider constraints are visible in adapter capabilities. Nucleus should not
pretend all harnesses support the same identity, resume, cancellation,
checkpointing, or permission model.

The first adapter trait split is metadata-first:

- runtime metadata exposes identity, capabilities, model routes, event identity
  policy, and terminal fallback policy
- lifecycle command support is separate from event ingestion
- canonical event kind support is separate from provider payload parsing
- terminal fallback never replaces structured event identity when a structured
  path exists
- model route metadata does not replace adapter instance identity

First-pass T3 Code research adds these adapter architecture rules:

- separate provider driver kind from provider instance id
- bind sessions and events to provider instance id
- emit canonical runtime events with provider-native refs retained
- keep approvals and structured user input in the adapter lifecycle
- make read/rollback support explicit capabilities
- keep remote access outside provider adapters

Kimi/Pi research adds these rules:

- ACP is the first Kimi Code path; Wire and SDK sidecar are secondary.
- Pi is RPC-first; SDK sidecar is secondary.
- adapters must support synthetic event ids for runtimes like Pi that stream
  events without ids.
- Pi command request ids are not event ids.
- Pi session-file entries and live RPC stream events are separate identity
  namespaces.
- Pi tree navigation, branching, and fork behavior must not be hidden behind a
  generic rollback label.
- Pi queue, retry, compaction, bash, extension UI, and command discovery
  surfaces are explicit capabilities.
- Pi has no built-in sandbox; any stronger isolation must be owned by nucleus
  or the deployment environment.

Codex readiness research adds these rules:

- Codex starts app-server-first, not terminal-first.
- Stdio or Unix socket app-server transport should be preferred before
  experimental WebSocket transport.
- Codex thread id is the provider session id for nucleus session binding.
- Approval and user-input requests must be surfaced as server-owned state.
- Generated app-server schema must be inspected before implementation.

Cursor readiness research adds these rules:

- Cursor CLI starts ACP stdio-first through `agent acp`.
- Cursor SDK and non-ACP CLI/headless flows remain separate adapter or route
  research surfaces.
- Cursor ACP session id is the provider session id for nucleus session binding.
- ACP request ids, message ids, tool-call ids, permission request ids, and
  extension method payloads must be retained.
- Missing ACP message ids require marked synthetic nucleus item ids.
- ACP session config options are preferred over legacy mode methods for model
  and mode selection.

OpenCode readiness research adds these rules:

- OpenCode starts server/SDK-first.
- `opencode acp` remains a real ACP transport path, but it is separate from
  the server/SDK adapter path.
- OpenCode adapter instances must expose server ownership mode: external
  server or nucleus-owned scoped local server.
- OpenCode session id is the provider session id for nucleus session binding.
- Message ids, part ids, tool-call ids, permission ids, question ids, and raw
  server events must be retained.
- OpenCode provider/model strings are model routes bound to an OpenCode
  adapter instance.
- OpenCode Zen and OpenRouter are routes inside the OpenCode harness unless a
  separate harness consumes them directly.

Claude readiness research adds these rules:

- Claude starts SDK-sidecar-first when provider and deployment constraints
  allow it.
- The sidecar is still process-backed: it supervises a Claude subprocess and
  local transcript state.
- Direct CLI and PTY remain required fallback paths.
- Claude permission modes and approval callbacks must stay visible as
  provider capabilities.
- Claude session recovery must separate conversation resume from filesystem
  checkpointing or rollback.
- PTY fallback must not pretend to provide structured message identity.

Kimi readiness research adds these rules:

- Kimi Code starts ACP stdio-first through `kimi acp`.
- Kimi ACP `session/load` and `session/resume` have different replay
  semantics and must stay separate.
- Kimi ACP session id is the provider session id for nucleus session binding.
- Raw Kimi tool-call ids and ACP turn-prefixed tool-call ids must both be
  retained.
- Tool approvals and question elicitation both use ACP
  `session/request_permission`, but must remain separate canonical wait
  states in nucleus.
- Kimi Wire remains a second research path for richer native event access.
- Terminal reverse-RPC is unsupported in current Kimi ACP, so shell execution
  remains owned by the Kimi process environment.

## Model Routing Layer

Model/provider routes sit below harness adapters.

The route layer owns:

- API compatibility family
- base URL or provider endpoint
- model id
- auth source
- context/capability metadata
- reasoning/cache/provider-specific request controls
- gateway routing/fallback policy

Harness adapters may reference model routes, but route id must not replace
provider instance id.

## Project Model

Projects are durable entities, not filesystem paths.

A project may contain one repo or many repos. A repo may move. Project identity
survives path changes through explicit repo records, path history, and repair
flows.

Projects carry activity state so inactive work can be parked without being
lost.

## Task Model

Tasks are first-class planning and execution units.

Tasks carry enough detail for semi-automated agent work:

- title
- description
- acceptance criteria
- action type
- importance
- staleness/neglect signal
- assignment state
- activity state

Project importance and task importance combine so neglected important work can
rise in the multi-project environment.

## Workspace Model

Workspace layout belongs to the project and persists across clients where
possible.

Expected workspace surfaces:

- agent panes
- terminal views
- browser views
- tabs
- panels
- per-project layout presets

## Invariants

- Tauri must not become the state authority.
- Adapters must preserve stable message and event identity.
- CLI-backed harnesses must be managed as process/session resources, not loose
  terminal tabs.
- Project records must survive repo path movement.
- Specs and contracts must lead major implementation work.

## Performance and Reliability Constraints

Early constraints:

- adapter event streams must avoid duplicate or unstable message ids
- project switching must not require scanning every repo
- active-project indicators must update from server-side activity state
- remote clients must be able to reconnect without losing server state

Concrete budgets will be set after the initial research pass.

## Interfaces With Roadmaps

This architecture unlocks:

- `docs/roadmaps/g01/001-foundation-and-research.md`

## Next Task

Draft adapter registry selection and persistence semantics.
