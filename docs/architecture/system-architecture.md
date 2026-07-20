# System Architecture

Status: draft
Owner: Tom
Updated: 2026-07-20
Vision refs: `docs/vision/001-nucleus-product-vision.md`

## Top-Level Stack

Nucleus is engine-first and host-flexible.

The portable Rust engine is the system core. It owns the domain logic for
project identity, task state, shared memory, structured planning records, deep
research records, agent sessions, workspace state, command policy, storage
records, projections, evidence, and harness lifecycle boundaries.

`docs/contracts/007-server-boundary-contract.md` is the host/API boundary, not
the umbrella system contract. Durable authority is split across focused
contracts for engine host authority, orchestration, conversation timelines,
runtime receipts, checkpoints, storage, SCM/forge, and harness adapters.

The engine can run inside multiple host forms:

- embedded desktop host
- local sidecar host
- remote authoritative host
- remote worker or proxy host
- managed team host
- custom host

The first user-facing shell is a Tauri desktop app. For single-user local work,
the desktop app may embed the engine directly and own the local authority
domains assigned to it. A separate `nucleusd` process remains useful for
always-on work, headless operation, crash isolation, remote clients, and
networked deployments, but it is not the only local architecture.

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
  event, model route, agent session lifecycle, and task-execution port types.
- `nucleus-agent-adapters`: Nucleus adapter registry and product-facing runtime
  bridge. Reusable harness discovery, protocol, event, callback, timeout, and
  cleanup mechanics come from Swallowtail adapters; Nucleus retains host and
  product authority. Agent Chat uses the read-only session profile; Goal/task
  execution uses the separately registered bounded-workspace task runtime.
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
- `nucleus-memory`: shared memory records, source refs, review state,
  sensitivity policy, and projection boundaries later.
- `nucleus-planning`: guided project planning sessions, planning artifacts,
  task seeds, and projection boundaries later.
- `nucleus-research`: deep research runs, questions, source records,
  observations, synthesis, confidence, gaps, and projection boundaries later.
- `nucleus-workspaces`: persisted display, window, region, and panel layout
  state.
- `nucleus-orchestration`: event-sourced command, event, projection, replay,
  receipt, and deterministic projection mechanics.
- `nucleus-engine`: portable domain execution, authority checks, command
  admission, projection coordination, repository traits, and host-independent
  effect ports.
- `nucleus-server`: host API, deployment, client, transport, DTO, Tauri IPC,
  and local/remote host wrapper surfaces for sidecar, remote, and embedded IPC
  forms.

Crates expose descriptive type surfaces only. The workspace exists to make the
intended boundaries visible before implementation.

## Host And Authority Flow

Host connection does not imply project authority.

Each project needs an authority map assigning domains to engine hosts:

- project authority
- source authority
- task authority
- workspace authority
- session authority
- execution authority
- terminal authority
- SCM/forge authority
- memory authority
- planning authority
- research authority
- credential authority
- audit/evidence authority
- projection authority

A UI may connect to many hosts. A host becomes authoritative only for the
domains assigned by the project authority map.

Common deployment shapes:

- embedded local: Tauri embeds the engine and owns local single-user authority
- local sidecar: `nucleusd` owns assigned local domains on the same machine
- remote authoritative: remote host owns project/source/session/execution
  domains for one or more projects
- remote worker/proxy: remote host provides model, harness, browser, terminal,
  or tool execution without owning project/source/task authority by default
- managed team: managed host owns team-scoped domains according to policy

Clients send commands and render state. They may cache for responsiveness, but
must reconcile with the authoritative host for the affected domain.

Hosts advertise protocol and capability records before clients assume a
workflow is available. Advertisement can expose host form, connection mode,
protocol profile, capability categories, authority-map publication posture, and
runtime readiness publication posture. It does not grant project authority.

The first desktop/local transport target is Tauri IPC. In-process transport
remains the test fixture and embedded-host fallback. Local sockets, named
pipes, loopback HTTP, LAN transport, and remote HTTP/WebSocket are deferred
until authority-map and auth gates are stronger.

Host-local storage is backend-adapter based. SQLite is the first single-player
local backend for embedded and sidecar hosts. A centralized remote team host
should be able to use PostgreSQL or another durable backend behind the same
domain repository traits without changing clients or domain rules.

Project management state also has a repo-backed projection path.

- authoritative host state is the active working set for assigned domains
- repo-backed files are the portable shared project intent
- accepted shared memories and planning artifacts may be projected when policy
  allows it
- accepted research synthesis may be projected when policy allows it
- Git and forges provide synchronization, review, and collaboration signals
- the project steward agent may help prepare sync commits and reconcile
  mechanical conflicts under explicit policy
- live runtime state, provider state, local caches, and secrets do not belong
  in the committable project projection by default
- terminal/browser state, client layout state, raw validation output, live
  agent sessions, and unclassified custom record kinds are local-only by
  default

Remote deployment is modeled above the adapter layer.

- host: one running engine wrapper
- access endpoint: one concrete way for a client to reach that host
- control plane: desktop, web, mobile, or CLI client

Hosts own providers, terminals, filesystem access, SCM operations, project
state, task state, workspace state, and runtime state only for the authority
domains assigned to them. Clients select access paths and execution targets;
they do not silently grant authority to a host.

Local command execution is host-authorized. SCM adapters, harness adapters,
validation workflows, and native personas request command authority from the
authoritative execution host instead of spawning processes directly.

Local host execution is gate-only until safety policy is proven in code. A
host may inspect command authority, structured invocation, project execution
authority, and requested sandbox labels, but it must not describe
`NoFilesystemWrite`, `ProjectRestricted`, `WorktreeRestricted`, or
`NetworkDenied` as enforced unless an OS sandbox, container, mount policy, or
equivalent host mechanism actually enforces the restriction.

The first future local spawn class is narrow: read-only inspection, low risk,
structured executable plus argv, validated project/worktree working directory,
minimal environment, finite timeout, finite stdout/stderr limits, summary-only
output, and enforced sandbox status. Anything outside that class remains
blocked before spawn.

Runtime scheduling starts as admission only. An authoritative execution host
may accept work into an inert queue when it has project, task, adapter,
command-authority, and event metadata refs. Queue admission is not execution:
it must not spawn provider processes, run commands, mutate worktrees, or start
background workers.

Effigy is an optional project tool integration. When enabled, it becomes a
first-class workflow surface for task discovery, health, validation planning,
and steward automation. Effigy invocation still goes through host command
authority; Nucleus does not let harnesses bypass command policy just because a
selector exists.

Nucleus should expose project tools through a low-cardinality portal model
where possible. Effigy is the model case: one canonical Effigy tool family can
publish action metadata for selector inventory, doctor summaries, validation
plans, selector execution requests, repair hints, and manifest proposals. This
avoids flooding agents with many narrow tools while still giving them a
discoverable action catalogue. If a bridged harness cannot expose dynamic
action metadata, the adapter must report that limitation and Nucleus should
fall back to a smaller portal, skill/prompt instructions, or server-side
execution with summarized evidence.

Workspace panels are client-rendered surfaces over authoritative host state.
Terminal and browser panels attach to host-managed runtime resources. Text and
code editor panels attach to host-authorized file and language-service state.
SCM changes, diff, and commit panels attach to the authoritative SCM host,
command authority, and review workflow state.

The first Terminal panel renders xterm in Svelte and talks through a
transport-neutral client interface. The embedded-host adapter uses Tauri
commands and channels, while `portable-pty`, project-root resolution, shell
selection, bounded output replay, and process cleanup stay in the host runtime.
A remote adapter must preserve the same session protocol and route to the
project's terminal authority host.

The first desktop Browser panel is a deliberate two-layer exception inside
that host-managed rule. Nucleus renders trusted navigation chrome in the main
bundled webview and positions an unprivileged native child webview beneath it.
The child receives no Nucleus Tauri capabilities. Its lifetime is keyed to the
panel id and its bounds follow the active panel viewport.

The first code editor uses CodeMirror 6 through official ESM packages inside a
thin Nucleus-owned Svelte adapter. CodeMirror owns responsive client editing
state only. Rust host APIs own project-scoped file discovery, opaque file
identity, content snapshots, write capability, revision-checked save, conflict
responses, and future language-server process lifecycle. Monaco and a VS Code
workbench are not part of the first editor surface.

Task-attributed source review uses a host-local content-addressed snapshot
backend. The task runtime captures an immutable baseline before provider
dispatch and an immutable target before awaiting review. Durable checkpoint
and diff records retain refs and summaries; bounded patch content is generated
on demand and remains transient. The client never receives snapshot storage
paths and never becomes source, snapshot, SCM, or review authority.

Command diagnostics panels are client-rendered read-only surfaces over the
host command history DTO. They render evidence rows, evidence detail, sanitized
summary, status, retention, and artifact refs. They do not decode storage
records, fetch artifact payloads, stream command output, or become command
authority.

The first desktop command diagnostics panel is a disposable proof surface. It
may keep selected evidence id, loading state, and last error in Svelte state,
but command records, evidence identity, retention, and artifact refs come from
Rust control DTOs. Replacing the panel must not require server migration or
state repair.

Command diagnostics list/detail behavior:

- list rows show evidence id, command request id, status, exit status,
  retention, summary preview, and artifact-ref presence
- detail view shows the same DTO fields plus full sanitized summary and exact
  artifact ref strings
- empty, unsupported, unauthorized, and failed query states stay visually
  distinct
- refresh requests the latest command history through the control helper
- command execution, cancellation, retry, approval, artifact payload download,
  PTY views, and streaming output stay absent until separate contracts exist

Runtime readiness diagnostics are a separate read-only client surface. Command
history answers what happened; runtime readiness answers what the current host
can safely do, what is blocked, and which sanitized repair hints apply. The
first DTO projects local host command execution readiness from sandbox,
artifact store, event transport, and process-control descriptors. It exposes
host id, runtime surface, status, blockers, evidence refs, repair hints, and
summary only.

The first desktop runtime readiness panel is a disposable proof surface over
that DTO. It may keep selected host id, loading state, and last error in
Svelte state, but readiness identity, status, blockers, evidence refs, hints,
and summary come from Rust control DTOs. It must not expose runtime repair,
command approval, artifact payload, PTY, or streaming controls.

The desktop client may use TypeScript-heavy editor and UI libraries. Rust
engine/host APIs remain the authority boundary for durable state, filesystem
access, command execution, SCM mutation, language-server process lifecycle,
credential access, and audit. Plugin planning must preserve that split: client
plugins can enrich editor and UI behavior, while host plugins or host APIs
must be policy-gated when they touch files, commands, SCM, credentials, or
durable state.

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

- Claude supports SDK-sidecar and CLI-backed routes; neither should erase the
  other.
- The sidecar is still process-backed: it supervises a Claude subprocess and
  local transcript state.
- Direct CLI is required for subscription-backed Claude Code use, diagnostics,
  one-shot tasks, and environments that reject sidecars.
- PTY remains the native rendering fallback.
- ACP or an equivalent structured protocol remains a future transport candidate
  if Anthropic exposes enough lifecycle, identity, permission, and resume
  coverage.
- Claude permission modes and approval callbacks must stay visible as
  provider capabilities.
- Claude authentication and billing posture must stay visible as configured
  adapter capabilities.
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

## Harness Mediation And Tool Projection

Nucleus has a canonical mediation layer around bridged harnesses.

The mediation layer can provide:

- canonical tool families projected into each harness by capability
- proactive steering messages backed by task, goal, roadmap, or evidence state
- sidecar tool execution with summarized results when direct tool injection is
  unavailable
- visible work forks for meaningful subagent work
- private helpers only for bounded summarization or classification

This layer must not claim all harnesses have equal tool support. Each adapter
declares whether a tool family can be projected through native tool
registration, MCP, ACP, SDK sidecar, prompt/skill instructions, sidecar
execution, or not at all.

Tool projection is governed by
`docs/contracts/024-harness-mediation-tool-projection-contract.md`.

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

Projects are Nucleus-owned logical work scopes, not filesystem paths.

A project may contain no work resource, one resource, or many resources. Plain
folders and Git repositories are initial resource kinds. Project and resource
identity survive locator changes through explicit membership records, locator
history, and repair flows.

Projects carry activity state so inactive work can be parked without being
lost.

A project may declare one active management projection targeting a Git
resource. It stores portable project metadata, task records, documentation,
decision records, and artifact references. It is a collaboration surface, not
the live runtime database.

Projects may be transient or durable. Transient projects support immediate
resource-free chat and promote in place when work is kept. Filesystem-dependent
panels and execution target explicit host-resolved resources or a project
default; they do not treat the project itself as a path.

`project-resource-lifecycle.md` owns the accepted structural detail.

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

## Shared Memory Model

Shared memory is server-owned project context.

It preserves accepted facts, decisions, preferences, constraints, risks,
handoff summaries, validation lessons, and open questions across harnesses and
clients.

Harness-native memory may be imported or linked only through explicit policy.
It is not the durable Nucleus memory authority.

Agents and skills may propose memory records, but the server owns ids,
sensitivity, review status, supersession, retention, and projection.

Accepted non-secret project memories may be projected to the management
repository. User-private memories, restricted notes, raw transcripts, raw
terminal output, and secrets remain outside shared projection by default.

## Structured Planning Model

Structured planning is server-owned project backbone state.

New projects should be able to start through a guided flow for vision,
ideation, architecture, constraints, research questions, roadmap shape, and
task seeds.

Open-ended exploration is a separate first-class mode. It is for broad project
conversation before finite plans: probing assumptions, comparing possibilities,
finding gaps, preserving unresolved questions, and deciding whether research,
proof work, planning artifacts, goals, or task seeds should be promoted.
Nucleus must not steer every exploratory conversation toward immediate coding.

Planning artifacts are structured records, not only generated markdown.
Northstar-shaped docs can remain an export or interoperability path, but the
product model needs stable planning sessions, accepted artifacts, task seeds,
review state, and source refs.

Task seeds become active tasks only through task-domain promotion. Planning
output should guide project organization without silently creating execution
work.

## Deep Research Model

Deep research is server-owned evidence work.

It can run as part of project planning or as a standalone investigation. A run
contains a brief, research questions, source records, observations, synthesis,
confidence, gaps, and promotion targets.

The system should distinguish evidence, inference, speculation, and
recommendation. Model-generated leads are not evidence until traced to sources
or accepted as speculation.

Accepted research may feed planning artifacts, task seeds, shared memories,
architecture docs, model-routing decisions, adapter choices, and project
guardrails. Draft research remains evidence and must not silently mutate those
domains.

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

When Effigy is enabled for a project, the steward should understand Effigy
deeply enough to inspect selectors, run health checks, plan validation, and
summarize evidence into task readiness and task history proposals. Effigy
knowledge is a tool capability, not hidden model intuition.

## Goals, Loops, And Next Task Selection

Goals, tasks, work items, loops, and next tasks are separate concepts.

A goal describes a desired outcome. A task is an actionable durable unit. A
work item is one execution attempt for a task. A loop is a runtime process that
advances a goal, task, or work item until explicit stop conditions are reached.

Nucleus should never provide a next task merely to satisfy a reporting ritual.
A next task must come from a known pathway: roadmap, project task queue, goal
decomposition, accepted planning artifact, validation repair path, recovery
state, or operator instruction. If no pathway is current, Nucleus should say
that planning is blocked instead of inventing work.

This is governed by
`docs/contracts/025-goal-loop-next-task-contract.md`.

The first realized Goal foundation lives in `nucleus-planning::goals`, reusing
`PlanningGoalId`. Goal records own ordered task membership, lifecycle status,
outcome, scope, stop conditions, evidence refs, next-task guidance, and
timestamps. JSON storage uses the Planning domain with the `Goal` persistence
record kind. Membership replacement requires the current record revision and
revalidates task existence, project ownership, uniqueness, ordering, and the
50-task first-slice bound.

Server commands, control DTOs, `task_ledger` projection, and desktop grouping
remain later product layers over this domain foundation.

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
- Shared memory must not collapse into raw transcript storage or hidden
  provider-native memory.
- Structured project planning must produce accepted artifacts and task seeds,
  not only chat history.
- Deep research must preserve source provenance and confidence, not just final
  prose.
- The project steward agent must operate under explicit sync policy.
- Tool projection must prefer portal tools and capability declarations over
  large flat tool lists.
- Next-task selection must be pathway-backed, not generated from thin air.
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

Runtime effect transport is selected by deployment profile and client needs.
Local socket, loopback HTTP, LAN HTTP, remote HTTP, WebSocket or stream
transport, polling, and custom gateways remain viable families. Any transport
must preserve server event ids, ordering tokens, storage generation posture,
replay catch-up, subscription lifecycle, retained refs, sanitized summaries,
client identity, and deployment profile limits.

Transport does not own replay, retention, storage, approval, command evidence,
adapter observations, retry lineage, recovery-required work, task state, or
workspace state. Auth and pairing remain separate readiness gates before
remote or LAN transport implementation.

Client auth and pairing are server-owned access boundaries. They map transport
credentials or pairing inputs onto stable client identities. Auth posture may
vary by deployment profile: local-only can allow explicit unpaired local
access, local-network requires pairing, internet-reachable requires normal auth
and revocation, and managed remote requires managed identity, invite, or
service credential reference posture.

Client auth is not command approval. Authenticated clients still pass through
command authority policy. Client auth records may store non-secret credential
references and revocation evidence, but credential material belongs behind a
future secret-store boundary.

Secret material is a distinct server boundary. Nucleus state may keep
credential refs, backend family, scope, status, redacted audit, rotation
posture, and revocation posture. Raw credential material belongs in a host
credential provider, OS keychain, external secret manager, provider-native auth
state, future Nucleus secret store, environment source, or user-interactive
resolution flow.

Credential resolution is separate from command approval. A command may be
approved but still blocked by missing credential policy. A credential may be
available but still unusable for a command without command authority.

## Interfaces With Roadmaps

This architecture unlocks:

- `docs/roadmaps/g02/001-orchestration-and-engine-boundary.md`
