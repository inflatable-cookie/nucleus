# System Architecture

Status: draft
Owner: Tom
Updated: 2026-06-16
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
  snapshot, journal, and projection envelope vocabulary.
- `nucleus-agent-protocol`: first draft adapter identity, capability, runtime
  event, model route, and agent session lifecycle types.
- `nucleus-agent-adapters`: first draft adapter registry, instance
  configuration, readiness, lifecycle, and health types.
- `nucleus-native-harness`: first draft Nucleus-owned persona, session, event,
  tool, approval, model backend, and audit boundary types.
- `nucleus-command-policy`: first draft command authority, sandbox, approval,
  and sanitized command evidence boundary types.
- `nucleus-projects`: durable project identity, repo membership, project
  lifecycle, and projection record types later.
- `nucleus-scm-forge`: first draft provider-agnostic SCM and forge adapter
  boundary types for repositories, worktrees, branches, commits,
  provider-neutral changes, pull requests, issues, comments, task links,
  credential references, webhook verification, conflicts, review workflows,
  observations, and capabilities.
- `nucleus-tasks`: task model, importance scoring, task action taxonomy, and
  projection record types later.
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

Project management state also has a repo-backed projection path.

- local server state is the active working set
- repo-backed files are the portable shared project intent
- Git and forges provide synchronization, review, and collaboration signals
- the project steward agent may help prepare sync commits and reconcile
  mechanical conflicts under explicit policy
- live runtime state, provider state, local caches, and secrets do not belong
  in the committable project projection by default

Remote deployment is modeled above the adapter layer.

- execution environment: one running nucleus server
- access endpoint: one concrete way for a client to reach that server
- control plane: desktop, web, mobile, or CLI client

The server owns providers, terminals, filesystem, git, project state, task
state, and workspace state. Clients select an access path; they do not split
the runtime.

Local command execution is server-authorized. SCM adapters, harness adapters,
validation workflows, and native personas request command authority from the
server instead of spawning processes directly.

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

Nucleus also needs an app-owned native harness family.

Bridged harnesses adapt external runtimes. Native harnesses are Nucleus-owned
agent runtimes for stewardship, organization, docs, validation summaries, and
sync assistance. They may use local or cloud models internally, but their
authority comes from Nucleus policy and server services, not from an external
provider runtime.

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

A project may declare a management repository root. That root stores portable
project metadata, task records, documentation, decision records, and references
to artifacts. It is a collaboration surface, not the live runtime database.

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

Task records should be project-portable where possible. Shared task intent can
be projected into small stable-id files in the management repository while the
server keeps richer local indexes and runtime state.

## SCM And Forge Sync

Git-backed project management is a first-class planning lane.

Nucleus should support a hybrid model:

- local database for fast active task/project state
- repo-backed projection for portable shared intent
- SCM/forge adapters for fetch, push, PR, issue, webhook, and review surfaces
- project steward agent for normalization, sync preparation, and conflict
  assistance

The server owns SCM work sessions. Clients may request branch, worktree,
review, or merge actions, but the durable session state belongs to the server.

Two first-pass work modes are required:

- primary worktree branch mode, where the known project checkout moves to a
  temporary branch or provider-equivalent change surface
- per-thread worktree mode, where each task attempt or thread can receive its
  own isolated checkout, branch-like ref, or provider-equivalent work area

Primary worktree branch mode is easier to run and test because the familiar
directory remains active. It is less flexible because concurrent threads share
one branch context.

Per-thread worktree mode supports parallel agent work. It needs extra runtime
constraint tracking because some projects can only run one dev server, build,
database, simulator, or hardware target cleanly on a machine.

Conflict and review workflow records are server-owned. Provider pull requests,
merge requests, branch refs, and issue refs remain linked metadata rather than
the durable source of Nucleus task or work-session identity.

SCM adapters expose workflow semantics. Git-like systems may treat commits as
the main shared authority primitive. Convergence-like systems may use local
snapshots for capture and publication/gate flow for shared authority.

SCM adapters also request command authority through the server. Read-only
inspection, management-state writes, source-code writes, network operations,
destructive operations, process lifecycle operations, and secret access are
separate command scopes.

The steward agent is bounded. It can prepare management-state commits, link
tasks to forge objects, and ask for human decisions. It must not silently delete
tasks, rewrite meaningful history, push code changes, or expose secrets.

## Native Harness Runtime

The first native harness target is the project steward.

Native personas may include:

- project steward
- task triage assistant
- documentation maintainer
- sync conflict assistant
- validation summarizer
- research librarian
- lightweight local helper

The native runtime should use deterministic tools first and model calls for
classification, summarization, merge suggestions, and ambiguity handling.
Small local models are preferred for cheap stewardship work when quality is
sufficient.

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
- Git-backed files are a shared projection, not the only runtime state store.
- The project steward agent must operate under explicit sync policy.
- Native harnesses must expose their app-owned authority boundary.
- Specs and contracts must lead major implementation work.

## Performance and Reliability Constraints

Early constraints:

- adapter event streams must avoid duplicate or unstable message ids
- project switching must not require scanning every repo
- active-project indicators must update from server-side activity state
- remote clients must be able to reconnect without losing server state

Concrete budgets will be set after the initial research pass.

## Production Adapter Trait Boundary

Production adapter traits should be drafted from the canonical contracts, not
from dev-only fixture APIs.

Initial trait families:

- SCM adapter: declares provider kind, capabilities, workflow semantics,
  repository and worktree observations, provider-neutral change refs, conflict
  observations, review-workflow links, and required command scopes.
- forge adapter: declares provider kind, capabilities, pull request / merge
  request refs, issue refs, comments, webhook verification evidence, polling
  observations, credential-use evidence, and review-workflow links.
- command authority boundary: owns command request policy, approval,
  sandboxing, execution, and sanitized evidence. SCM and forge adapters may
  request command authority; they must not execute host commands directly.
- observation source: normalizes provider events into server-owned
  observations with stable ids, dedupe keys, effect hints, and provider refs as
  metadata.

First production traits can be value-returning where they describe identity,
capability, workflow semantics, and readiness. Operations that observe external
state, follow event streams, execute command-backed actions, or interact with
webhooks should be designed as effectful boundaries later. The docs must not
force an async runtime, stream type, transport, or registry implementation yet.

The trait vocabulary must not assume Git. Git-like adapters may use commit,
branch, and pull request semantics. Convergence-like adapters may use snapshot,
publication, gate, bundle, or release semantics. The adapter contract names
which workflow primitive is local capture, shared authority, and review
boundary instead of making those terms implicit.

## Adapter Runtime Effect Boundary

Static adapter traits describe what an adapter is and what it can do. Runtime
effects describe work that touches outside state, long-running state, or
server-owned authority.

Initial effect categories:

- refresh: inspect provider state and return normalized observation batches
- poll: repeat refresh under server scheduling policy
- webhook input: verify provider input and return sanitized evidence plus
  observations
- command request: ask server command authority for command-backed work
- command result: receive sanitized command evidence from the server boundary
- event subscription: follow provider event streams where supported
- cancellation: request interruption of an in-flight effect
- recovery: rebuild adapter runtime state after restart, reconnect, or
  provider interruption

Runtime effects must return data for server normalization. They must not mutate
project, task, workspace, projection, or history state directly. Provider refs
remain metadata; server-owned ids remain authoritative.

The server owns scheduling, authorization, command execution, cancellation
policy, retries, dedupe, persistence, and event fan-out. Adapters own provider
translation and provider-specific capability limits.

Async runtime, stream type, cancellation primitive, retry scheduler, replay
store, and transport selection are deferred. The first effect contract should
name effect requests, effect outcomes, cancellation semantics, and observation
batch rules before Rust effect traits are implemented.

## Runtime Effect Trait Direction

Runtime effect traits should preserve a two-phase shape:

- request acceptance: accepted, rejected, queued, blocked, unsupported, or
  approval-required
- outcome reporting: normalized observations, sanitized evidence, cancellation,
  timeout, failure, recovery, or retry classification

The split keeps scheduler state out of provider adapters and command runners.
Adapters can report what they can do and what happened. The server remains the
authority for when work starts, whether it retries, how cancellation is
recorded, how output is retained, and how clients receive events.

SCM and forge runtime traits should return normalized observation batches,
task-link proposals, conflict records, review-workflow refs, credential-use
evidence, webhook-verification evidence, or command-authority requests.

Command runtime traits should return sanitized command evidence. Raw process
output and artifact material stay behind explicit retention policy.

The first trait skeleton should be value-shaped and compile-only. It should not
select async runtime, stream types, polling workers, webhook server, PTY
strategy, sandbox backend, process supervisor, artifact store, or replay store.

## Runtime Effect State Direction

Runtime effects have server-owned state transitions.

Adapters and command runners may report acceptance, queued/running posture,
cancellation posture, recovery need, and final outcomes. They do not own retry
loops, timeout policy, persistence, event fan-out, approval state, or artifact
retention.

Effect states are split into non-terminal and terminal groups. Requested,
accepted, queued, running, cancellation requested, approval required, policy
inspection, and recovery required are non-terminal. Rejected, blocked by
policy, unsupported, succeeded, failed, cancelled, and timed out are terminal.

Cancellation requested is not terminal. Recovery required is not terminal until
the server decides no recovery path remains. Retry classification belongs to
terminal or recovery-required outcomes, and a retry is represented as a new
effect request under server scheduling authority.

Server events should expose effect state changes after normalization and
sanitization. They should not expose raw provider payloads, raw command output,
credentials, or machine-local paths by default.

Runtime effect events should use a common server-owned envelope with separate
adapter and command payloads. The envelope carries event identity, ordering,
effect request identity, event time, retry linkage, and summaries. Payloads
carry domain-specific refs such as sanitized command evidence refs, artifact
refs, normalized observation batch refs, task-link proposal refs, credential or
webhook evidence refs, and command-authority request refs.

Effect events are client reconciliation signals. They are not the persistence
schema, replay store, transport contract, scheduler, or authority for state
mutation.

Runtime effect replay should retain durable effect state changes long enough
for server restart and client reconnection. Repeated progress and heartbeat
events may be compacted after a durable successor exists. Sanitized evidence
refs, artifact refs, observation refs, retry linkage, and terminal outcomes
must not be dropped while retained events still point to them.

Replay and retention policy may differ by deployment profile. The policy does
not choose a database, replay API, event bus, transport, artifact store, or
client subscription model.

Runtime effect storage is a server-owned storage boundary over normalized
event records and retained refs. It should keep stable event identity,
ordering, effect request identity, retry lineage, latest recoverable state,
terminal state, sanitized command evidence refs, adapter observation refs, and
artifact refs. It must not copy raw command output, terminal byte streams, raw
provider payloads, raw webhook payloads, credentials, or large validation
output into event records by default.

Replay remains deferred until the storage layer can resolve retained refs,
list events by effect request, list events after a client ordering token, find
latest effect state, and find recovery-required effects after restart.

Runtime effect replay queries are pull-style reconciliation requests. Clients
may request events after a server ordering token, events by effect request,
latest state, retry lineage, recovery-required effects, and retained ref
resolution. Responses may include retained events, compacted checkpoints,
latest-state summaries, missing-ref notices, expired-ref notices, unsupported
query notices, and partial-result notices.

Client ordering tokens are not authority. They are server-scoped hints for what
the client last rendered. They do not prove the client has complete provider,
command, task, workspace, projection, or artifact state. Clients may cache
responses, but the server remains authoritative for stored effect state and
recovery work.

Runtime effect subscriptions are live delivery surfaces after replay
catch-up. A subscription may be accepted, require replay first, begin from a
checkpoint, enter backpressure, close, or require reconnect. Delivery
acknowledgements are client-rendering hints only. They do not mutate durable
effect state, storage retention, command evidence, adapter observations, retry
lineage, recovery-required work, task state, or workspace state.

Subscription transport remains open. WebSocket, HTTP, local socket, polling,
or another mechanism can be chosen later without changing the server-owned
event identity, ordering, replay, and storage semantics.

## Interfaces With Roadmaps

This architecture unlocks:

- `docs/roadmaps/g01/001-foundation-and-research.md`
