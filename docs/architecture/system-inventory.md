# System Inventory

Status: draft
Owner: Tom
Updated: 2026-06-16

## Repos

- `nucleus`: current repo, docs authority and future Rust workspace.
- `external/t3code`: ignored research clone, not vendored product code.

## Rust Crates

- `nucleus-core`: first draft persistence domains, record identity, revision,
  snapshot, journal, projection envelope vocabulary, and storage-boundary
  contract docs. Runtime effect storage is documented as server-owned
  normalized event and ref storage, but no Rust storage types or persistence
  implementation exist yet.
- `nucleus-agent-protocol`: first draft adapter identity, transport,
  capability, event identity, model-route, and agent session lifecycle types.
- `nucleus-agent-adapters`: first draft adapter registry, instance
  configuration, readiness, lifecycle, and health types.
- `nucleus-native-harness`: first draft Nucleus-owned persona, session, event,
  tool, approval, model backend, and audit boundary types.
- `nucleus-command-policy`: first draft command authority, sandbox, approval,
  and sanitized command evidence boundary types. Current contracts define the
  first production command authority trait boundary in docs, with
  a static policy-inspection trait skeleton now present. Runtime command
  effects are documented and have type-only request/outcome vocabulary.
  Runtime command effect trait responsibilities are drafted in docs, with
  value-shaped request-acceptance and outcome-reporting trait skeletons now
  present. Runtime command effect state-machine policy is documented, but no
  scheduler exists. Value-shaped command runtime effect state types now name
  non-terminal states, terminal states, state records, and optional retry
  classification. Runtime command effect event vocabulary is documented, with
  compile-only command event payload types now present. No event transport,
  persistence, replay, or subscriptions exist. Runtime effect replay and
  retention policy is documented, but no Rust replay or retention policy types
  exist. Command runner and sandbox runtime readiness is documented, with
  compile-only readiness surface, gate, blocker, environment, output-capture,
  interruption, and readiness-plan types now present. No command runner,
  process spawning, sandbox backend, credential injection, output capture,
  artifact store, scheduler, or evidence publisher exists. Command artifact
  and output retention policy is documented, with compile-only artifact
  payload class, approval, secret-scan, redaction, resolution, retention
  policy, and descriptor types now present. No artifact backend, payload
  storage, secret scanner, redactor, replay exposure, or UI rendering exists.
- `nucleus-contract-fixtures`: dev-only, unpublished contract fixture
  vocabulary crate for provider-neutral SCM/forge and command-policy contract
  tests. Production crates must not depend on it. The first integration tests
  prove provider-neutral workflow, command-policy, sanitized-evidence,
  task-link, conflict, and review vocabulary without live providers. It also
  contains deterministic fake adapter skeletons for command-policy, SCM, and
  forge test surfaces plus ordered scenario scripts for management-state sync
  and blocked-policy / rejected-review paths.
- `nucleus-local-store`: compile-only server-local storage boundary crate. It
  names backend, domain, repository, error, fixture, and SQLite module
  boundaries for the first storage runway. It now includes synchronous
  repository trait vocabulary, opaque payload records, revision expectations,
  transaction posture vocabulary, storage error vocabulary, and an in-memory
  conformance fixture for create/read/update/list/delete behavior. It also
  names a backend adapter trait so SQLite, future PostgreSQL, remote database,
  and fixture backends can expose the same domain repository boundary. SQLite
  now stores generic project, task, workspace, adapter registry, agent session,
  model route, event journal, command evidence metadata, artifact metadata,
  and runtime effect records behind that trait, with restart-recovery tests.
  It depends on `nucleus-core` for persistence vocabulary. It does not
  implement backend transactions, serialization, migrations beyond the first
  SQLite schema, projection import/export, credential lookup, artifact payload
  storage, live adapter/runtime behavior, replay APIs, subscriptions, or
  team-server database behavior. Restart tests now prove all first SQLite
  domains recover from one database, metadata refs recover without secret or
  artifact payload material, and projection files are not imported as active
  server state.
- `nucleus-effigy-integration`: planned, not scaffolded. Future optional
  project workflow integration crate or module for Effigy selector discovery,
  doctor/test-plan summaries, health posture, task validation refs, and
  steward tool surfaces. The local store crate leaves room for project tooling
  and Effigy integration records, but no Effigy tool bridge, harness skill
  injection, command execution, or UI exists yet.
- `nucleus-projects`: first draft durable project, repo membership, path
  history, repair action, activity, projection record types, and a Rust-owned
  JSON storage codec for first project display records. The codec preserves
  stable project id, display name, status, and importance baseline for
  server-owned storage/control projection use.
- `nucleus-scm-forge`: first draft provider-agnostic SCM, forge, credential,
  webhook, conflict, review-workflow, task-link, observation, and work-session
  boundary types. Current contracts define the first production adapter trait
  boundary in docs, with static SCM, forge, and observation-source trait
  skeletons now present. Runtime SCM/forge effects are documented and have
  type-only request/outcome vocabulary. Runtime SCM/forge effect trait
  responsibilities are drafted in docs, with value-shaped SCM and forge
  request-acceptance and outcome-reporting trait skeletons now present.
  Runtime SCM/forge effect state-machine policy is documented, but no scheduler
  exists. Value-shaped adapter runtime effect state types now name
  non-terminal states, terminal states, state records, and optional retry
  classification. Runtime adapter effect event vocabulary is documented, with
  compile-only adapter event payload types now present. No event transport,
  persistence, replay, or subscriptions exist. Adapter replay and retention
  policy is documented, but no Rust replay or retention policy types exist.
- `nucleus-tasks`: first draft task identity, importance, neglect, action,
  assignment, activity, agent-readiness, and projection record types. It now
  includes a Rust-owned JSON storage codec for first task display records. The
  codec preserves stable task id, project id, title, description, acceptance
  criteria, importance, action type, activity, assignment intent, and
  agent-readiness fields for server-owned storage/control projection use. The
  storage projection can now rebuild a domain task for create/update-safe
  fields while leaving runtime, history, provider, and command evidence state
  outside the projection.
- `nucleus-memory`: focused crate scaffold is present. It currently has a
  small front door and named modules for ids, proposals, source refs, review
  vocabulary, and storage shape. Memory proposal records now cover stable
  ids, scopes, kinds, proposal-only statuses, title, sanitized payload
  summary/detail, source refs, confidence, and timestamps. Tests prove proposed
  memory is not authoritative accepted memory, source refs are not memory
  identity, and scope/kind do not grant visibility or projection authority.
  Review, sensitivity, retention, and supersession records now represent
  user-private, restricted, secret-adjacent, local-only, expiry, archive, and
  proposal-lineage boundaries without accepting memory or granting projection
  authority. Cross-domain linkage refs and JSON storage records now cover
  planning sessions, exploration sessions, planning artifacts, task seeds,
  research briefs, tasks, sanitized evidence refs, source refs, review,
  sensitivity, retention, supersession, and timestamps. The codec round trips
  the storage shape and excludes raw transcripts, provider payloads, terminal
  streams, credentials, secret values, and private notes. Promotion target
  refs, accepted memory mutation, embeddings, semantic search, autonomous
  extraction, provider-native memory sync, projection files, final review UI,
  and private-note storage by default remain deferred. Read-only memory
  proposal inspection is now available through server query/control DTO,
  `nucleusd query memory-proposals`, and Effigy, returning sanitized counts and
  refs only.
- `nucleus-planning`: focused crate scaffold is present. It currently has a
  small front door and named modules for ids, sessions, exploration,
  artifacts, refs, and storage shape. Guided planning session value records now
  cover session ids, project ids, kinds, statuses, participants, source refs,
  output refs, and timestamps without storage or runtime effects. Open-ended
  exploration records now cover exploration sessions, question backlogs,
  assumptions, options, tradeoffs, risks, opportunities, constraints, decision
  refs, and explicit promotion refs without forcing next-task creation.
  Planning artifact and task-seed linkage records now map app-native planning
  refs to existing engine/server compatibility records while preserving task
  seed promotion authority in the task-domain path. The crate now has a first
  JSON storage codec for planning session and exploration session storage
  records, including stable ids, statuses, refs, questions, assumptions,
  options, notes, and promotion refs. The codec deliberately excludes raw
  transcripts, provider payloads, secrets, private memories, active task
  mutation, projection/import apply, model orchestration, task creation, memory
  extraction, deep research execution, and UI behavior.
- `nucleus-research`: focused crate scaffold is present. It currently has a
  small front door and named modules for ids, runs, questions, sources,
  synthesis, refs, and storage shape. Research run brief records now cover
  stable ids, optional project refs for project-bound or standalone runs,
  title, sanitized brief text, status, scope boundary, source plan refs,
  confidence, coverage summary, and timestamps. Tests prove run briefs are not
  active execution, status does not grant execution authority, and scope does
  not grant source access authority. Research question records now cover
  question ids, run refs, priority, status, source requirements, answer
  summaries, evidence refs, and open gap refs without execution authority or
  raw source payload storage. Source refs now cover web pages, official docs,
  source repos, code files, issues/discussions, papers, PDFs, package
  registries, local files, human notes, model-generated leads, and custom refs
  with reliability and retrieval-method hints only. Observations and synthesis
  refs now distinguish evidence, inference, speculation, and recommendation,
  and link candidate promotion targets to memory proposals, planning artifacts,
  task seeds, and source evidence by ref only. Crawlers, browser automation,
  source retrieval, model orchestration, citation rendering, raw source
  retention, promotion, projection/apply, task creation, and UI behavior remain
  out of scope. JSON storage records now round-trip run briefs, questions,
  source refs, observations, synthesis refs, confidence, coverage, and
  promotion target refs while excluding raw browser caches, copyrighted source
  payloads, raw transcripts, provider payloads, private notes, credentials, and
  secret-bearing files. Read-only inspection is now available through server
  query/control DTO, `nucleusd query research-run-briefs`, and Effigy, returning
  sanitized counts and refs only.
- `nucleus-workspaces`: first draft modular workspace layout and local
  workspace hosting types. It now models the Loophole-inspired
  display/window/surface/region/panel hierarchy at the Rust type and pure
  helper level: display inventory, window placement, display fallback
  planning, hosted surfaces, active-surface fallback, Nucleus regions,
  per-project panel rules, selected-task shell seed rules, and local-only
  global shell / project panel layout record families. Rendering, local SQLite
  codecs, migrations, terminal/browser/editor/SCM resource execution, sync,
  and Aura-style configuration UI remain out of scope.
- `nucleus-server`: current crate name for host API/runtime boundary types.
  The name is historical after the engine-first correction: the crate remains
  useful for sidecar daemon, remote host, and embedded IPC/control surfaces,
  but it is not the system core. Future refactoring may split reusable engine
  services from host API wrappers. For now, read "server-owned" entries below
  as "authoritative engine host owned" unless the entry specifically refers to
  `nucleusd` as a daemon.
  Durable authority should resolve through focused contracts before the broad
  server boundary: `017` for host authority, `018` for orchestration, `019` for
  conversation timelines, `020` for runtime receipts, `021` for checkpoints,
  and `022` for engine/orchestration/host crate ownership.
  It now includes a local host-owned state service facade over
  `nucleus-local-store` backend adapters for the
  first persisted domains. The facade keeps repository handles out of the
  client boundary and is transport-free. It also now includes transport-neutral
  control API request, command/query, response, result, and error vocabulary.
  Control API types cover project, task, workspace, adapter/session, model
  route, runtime metadata, and read-only planning session query surfaces. The
  planning session query scans the planning local-store domain, decodes
  app-native planning session records, reports sanitized session counts, status
  counts, source-kind counts, prompt/template refs, and output refs, and keeps
  source material values, provider payloads, secrets, private memories,
  mutation, task creation, and runtime effects out of the response. `nucleusd`
  and Effigy have a bootstrap-backed `planning-sessions` query for inspection.
  Local client auth readiness gates now allow explicit local-only
  unpaired access, deny unsupported local auth states, and defer remote-style
  auth postures without implementing auth flows. It does not implement
  networking, pairing, command execution, scheduling, provider processes, live
  subscriptions, or Tauri integration. Runtime effect server event envelope
  types are compile-only and do not implement transport, persistence, replay,
  subscriptions, scheduling, or runtime execution. Runtime effect replay and
  retention policy types are compile-only and do not implement storage, replay
  APIs, event transport, artifact stores, subscriptions, scheduling, or runtime
  execution. A read-only event replay query service skeleton now reads stored
  event journal metadata and optional runtime effect metadata through the
  server state facade, supports all-events and cursor queries, and reports
  time-window queries as unsupported until event timestamps are indexed. It
  does not implement live subscriptions, event fanout, payload resolution,
  transcript storage, scheduling, or runtime execution. An inert runtime
  scheduler acceptance queue now admits shaped work with project, task,
  adapter, command-authority, and event metadata refs, but it does not spawn
  processes, run commands, start providers, mutate worktrees, retry work, or
  run background workers. Runtime effect storage boundaries are documented, but
  no storage refs, checkpoints, replay indexes, persistence backend, or replay
  API exists beyond this first metadata query skeleton. A transport-neutral
  local control request handler skeleton now accepts control requests, applies
  optional auth readiness gates, and returns explicit deferred query responses
  or rejected command receipts. The request handler boundary is now split into
  focused modules for the boundary marker, core handler, command receipts,
  query execution, and tests. It wires state, replay, and scheduler services as
  inert dependencies. It now executes read-only project, task, workspace,
  adapter/session, model route, and runtime metadata state queries for direct
  get/list paths. Indexed filters and runtime ref resolution remain explicit
  unsupported paths. It now mutates task activity state for the first supported
  task transition commands: start, block, complete, and archive. Those
  transitions update existing task records durably while preserving unrelated
  stored task display fields and surfacing not-found, conflict, and
  invalid-storage failures as rejected command receipts. It now also executes
  first task create/update commands through the server state service using
  task authoring input, project existence validation, title validation,
  agent-readiness checks, revision expectations, and read-after-write DTO
  visibility. It does not open transports, start providers, execute runtime
  work, or deliver subscriptions. Codex supervision now also contains
  server-owned session binding and ingestion source record types that preserve
  Nucleus session authority, provider refs, binding confidence, recovery
  state, frame method, transport sequence, and raw-payload retention policy.
  Duplicate-safe Codex frame acceptance records now classify accepted,
  duplicate, unsupported, out-of-order, and recovery-required observations
  before event-store append. These records do not open stdio, decode live
  transport, persist idempotency state, append event-store records, or run
  provider commands. Runtime-observation event-store linkage records now map
  accepted Codex observations to orchestration event-store envelopes and
  optional sanitized runtime receipt refs. They do not append records or replay
  provider work. Task-runtime observation link records now attach those
  accepted, receipt-only, duplicate, unsupported, or recovery-required
  observation refs to task work items without granting task state mutation.
  Read-only Codex ingestion diagnostics DTOs expose observation status, next
  action, event refs, receipt refs, evidence refs, and mutation-authority flags
  without adding UI panels. Codex owned-runtime instance records now describe
  host, adapter, process owner, binary, endpoint, payload retention, lifecycle
  state, and evidence refs without storing process handles or spawning Codex.
  Codex stdio frame source records now describe direction, sequence, decode
  status, payload-retention posture, and evidence refs without opening stdio
  or retaining raw frames.
  Codex spawn-intent admission records now compose readiness blockers and
  runtime instance state without starting a provider process.
  Codex startup and decode receipt mappings now turn blocked spawn intent,
  malformed frames, unsupported frames, and recovery-required frames into
  sanitized harness-provider runtime receipts without raw stream retention.
  Command handling still treats other state-shaped commands as accepted for
  later state mutation handling, while runtime session commands are rejected
  through scheduler admission or explicit deferred runtime-control errors. Local
  transport readiness types now name in-process, Tauri IPC, Unix-domain
  socket, Windows named pipe, loopback HTTP, and custom candidates, plus
  desktop bootstrap requirements and blockers. They do not implement any
  transport or listener lifecycle. A local control transport trait boundary now
  names request/response exchanges, readiness reporting, and transport errors.
  It is synchronous and local-only; it does not implement a socket, HTTP
  server, WebSocket server, Tauri IPC command, remote pairing flow, or live
  subscription channel. The local transport boundary is now split into focused
  modules for boundary types, scripted fixtures, handler-backed fixtures, and
  tests. A non-production in-process control client fixture implements that
  trait with scripted responses and recorded exchanges. It proves local
  request/response carrying. A handler-backed in-process fixture now routes
  requests through `LocalControlRequestHandler` and proves read-only state
  queries plus command receipts through the transport boundary. It still does
  not implement Tauri IPC, network transport, socket listeners, state mutation
  execution, runtime execution, or background workers. Tauri IPC schema
  readiness types now name the first desktop command schema, control envelopes,
  and IPC blockers without implementing Tauri commands, serialization, or a
  desktop app. Control API serialization readiness types now name request and
  response envelope fields, id stability, versioning, error-shape, payload
  compatibility, and codec blockers without adding serde derives or
  implementing transport behavior. The first desktop IPC wire format is named
  as JSON with exact-match `nucleus.control` v1 versioning and a
  `desktop-ipc-json` codec boundary. Transport DTO authority is explicitly
  boundary-only and distinct from durable server authority. Serializable
  control envelope DTOs now cover the first request/response envelopes,
  supported state and runtime metadata query shapes, response status, state
  record payload envelopes, command receipt summaries, and explicit error
  shapes. Project and task state query responses can now expose display-ready
  typed DTOs decoded from server-owned storage payloads. The first command DTO
  subset now supports task activity transition commands for start, block,
  complete, and archive with optional expected revision. It also supports first
  task create/update command DTOs using authoring input rather than raw storage
  records. Unsupported payloads fail with codec errors. Tauri IPC readiness can
  now consume explicit control
  serialization readiness. A Tauri IPC command
  boundary skeleton now names schema-only, fixture-backed, and Tauri
  runtime-backed postures plus a request/response submission trait. It does not
  use Tauri macros, start a Tauri runtime, serialize payloads, own durable
  state, or implement desktop IPC. A non-production Tauri IPC-shaped command
  fixture now routes `ServerControlRequest` values through
  `LocalControlRequestHandler` and records `ServerControlResponse` exchanges.
  It proves one local request/response path without a Tauri app or real IPC. A
  runtime-free Tauri command adapter now accepts serializable request DTOs,
  decodes them into server control requests, routes through the local handler,
  and encodes serializable response DTOs. Decode and encode failures remain
  codec errors, not server authority errors.
  Runtime effect storage boundary types now name retained event records,
  storage refs, replay checkpoints, stored effect states, and query postures,
  but they do not implement persistence, serialization, replay APIs, event
  transport, subscriptions, artifact stores, scheduling, command execution, or
  adapter execution. Runtime effect replay query types now name client ordering
  tokens, storage generation posture, query requests, responses, result items,
  status, unsupported reasons, and ref-resolution states, but they do not
  implement replay, persistence, transport, subscriptions, artifact storage,
  client caching, scheduling, command execution, or adapter execution. Runtime
  effect subscription types now name subscription ids, handshakes, lifecycle
  states, acknowledgement posture, backpressure posture, disconnect reasons,
  and reconnect requirements, but they do not implement transport, event bus,
  replay service, persistence, acknowledgement processing, client caching,
  scheduling, command execution, or adapter execution. Runtime effect
  transport selection types now name transport family, transport profile,
  capability, boundary guarantees, selection criteria, and auth blockers, but
  they do not implement networking, event bus, auth, pairing, replay service,
  subscription delivery, storage, scheduling, command execution, or adapter
  execution. Client auth and pairing types now name auth record ids, pairing
  ids, auth session ids, auth posture, pairing mode, deployment policy, pairing
  records, auth session records, and revocation records, but they do not
  implement auth, pairing flows, credential material storage, secret storage,
  transport, command approval, provider credentials, model credentials, or
  runtime execution. Secret material boundary types now name credential
  material refs, material classes, backend families, material statuses,
  resolution scopes, resolution requests, access policy, redaction policy,
  rotation policy, revocation policy, and sanitized audit records, but they do
  not implement secret storage, encryption, backend integration, provider auth,
  command execution, credential injection, or raw credential access.
  Credential resolution integration types now name domain integration refs,
  integration records, blocking impacts, repair actions, and blockers, but they
  do not resolve credentials, prompt users, access backends, inject secrets,
  execute commands, call providers, or implement UI. Credential runtime
  readiness types now name runtime material receiver boundaries, lookup
  readiness states, preflight records, audit capture posture, repair work
  items, and readiness outcomes, but they do not resolve credentials, prompt
  users, access backends, inject secrets, execute commands, call providers, or
  implement UI. Command runtime readiness envelope types now bind command
  runner readiness plans to server command ids, but they do not schedule
  commands, spawn processes, implement sandboxes, resolve credentials, capture
  output, retain artifacts, publish events, or execute commands. Command
  artifact envelope types now bind artifact descriptors to server command ids
  and resolution status, but they do not store payloads, select a backend, scan
  secrets, redact payloads, resolve refs, expose replay payloads, render UI, or
  execute commands.
- `nucleus-server` also provides a server-owned local project seed path for
  bootstrap readiness. `seed_local_project` writes idempotent project records
  through `ServerStateService` using the `nucleus-projects` JSON storage codec.
  It is seed behavior, not full project creation command execution.
- `nucleus-server` also provides a server-owned local task seed path for
  bootstrap readiness. `seed_local_task` writes idempotent task records through
  `ServerStateService` using the `nucleus-tasks` JSON storage codec and reads
  back through the typed `task_records` control DTO boundary. It is seed
  behavior separate from normal task creation command execution.

## Apps

- `apps/nucleusd`: local Rust host smoke binary. It opens SQLite-backed host
  state, can seed the local bootstrap project and task, and prints
  project/task counts through `LocalControlRequestHandler`. It can also query
  local project, task, workspace, and command evidence records through the same
  handler and print sanitized metadata. It does not open a network listener,
  run as a daemon, execute commands, start providers, or deliver subscriptions.
- `apps/desktop`: initial Tauri v2 desktop client scaffold. It uses Bun,
  Svelte, and local Poodle component packages from `../poodle`. The first
  panel is read-only control diagnostics that invokes `submit_control_envelope`
  and renders protocol details, request status, raw DTO response, and errors.
  Local desktop startup seeds a `Nucleus Local` project through the server
  seed path and a bootstrap local task through the task seed path. A read-only
  project switcher panel lists `project_records` DTOs and keeps selection in
  local shell state. A task list panel lists `task_records` DTOs. Shell-level
  task selection and task detail display use typed task DTOs as local view
  state. Task detail transition controls can submit start, block, complete,
  and archive commands, then refresh task records. A disposable read-only
  planning proof panel queries planning sessions, memory proposals, and
  research run briefs through the same control envelope and renders summary
  DTOs only. It does not implement project/task create/edit forms, accepted
  memory mutation, planning import apply/review, research execution, live
  subscriptions, provider process lifecycle, remote transport, command
  execution, persisted focus, final UI layout, or durable state authority.

## External Systems To Research

- T3 Code
- Agent Client Protocol
- Codex CLI
- Claude Code
- Cursor SDK and CLI
- OpenCode ACP
- Kimi CLI and Kimi Agent SDK
- Pi
- GLM/Z.ai
- MiniMax
- DeepSeek
- OpenRouter
- OpenCode Zen

## T3 Code Provider Integration Paths

- Provider adapter contract:
  `external/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
- Runtime event contract:
  `external/t3code/packages/contracts/src/providerRuntime.ts`
- Provider instance identity:
  `external/t3code/packages/contracts/src/providerInstance.ts`
- Codex adapter:
  `external/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
- Claude adapter:
  `external/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Cursor adapter:
  `external/t3code/apps/server/src/provider/Layers/CursorAdapter.ts`
- OpenCode adapter:
  `external/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- ACP runtime:
  `external/t3code/apps/server/src/provider/acp/AcpSessionRuntime.ts`
- OpenCode runtime:
  `external/t3code/apps/server/src/provider/opencodeRuntime.ts`
- Remote architecture:
  `external/t3code/docs/architecture/remote.md`
