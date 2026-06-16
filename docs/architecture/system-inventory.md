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
  history, repair action, activity, and projection record types.
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
  assignment, activity, agent-readiness, and projection record types.
- `nucleus-memory`: planned, not scaffolded. Future shared memory crate for
  memory records, scopes, source refs, review state, sensitivity, retention,
  and projection boundaries. The local store crate leaves room for this domain,
  but no Rust memory domain crate or behavior exists yet.
- `nucleus-planning`: planned, not scaffolded. Future structured planning
  crate for planning sessions, accepted artifacts, task seeds, review state,
  and projection boundaries. The local store crate leaves room for this domain,
  but no Rust planning domain crate or behavior exists yet.
- `nucleus-research`: planned, not scaffolded. Future deep research crate for
  research runs, question sets, source records, observations, synthesis,
  confidence, gaps, and projection boundaries. The local store crate leaves
  room for this domain, but no Rust research domain crate or behavior exists
  yet.
- `nucleus-workspaces`: first draft modular workspace layout, panel, and
  surface types.
- `nucleus-server`: first draft modular server authority, deployment, client,
  command, event, and state facade types. It now includes a local server-owned
  state service facade over `nucleus-local-store` backend adapters for the
  first persisted domains. The facade keeps repository handles out of the
  client boundary and is transport-free. It also now includes transport-neutral
  control API request, command/query, response, result, and error vocabulary.
  Control API types cover project, task, workspace, adapter/session, model
  route, and runtime metadata query surfaces, but do not implement request
  handling. Local client auth readiness gates now allow explicit local-only
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
  or rejected command receipts. It wires state, replay, and scheduler services
  as inert dependencies. It now executes read-only project, task, workspace,
  adapter/session, model route, and runtime metadata state queries for direct
  get/list paths. Indexed filters and runtime ref resolution remain explicit
  unsupported paths. It does not mutate state, run commands, open transports,
  start providers, or deliver subscriptions. Command handling now returns
  deterministic receipts: state-shaped commands are accepted for later state
  mutation handling, while runtime session commands are rejected through
  scheduler admission or explicit deferred runtime-control errors. Local
  transport readiness types now name in-process, Tauri IPC, Unix-domain
  socket, Windows named pipe, loopback HTTP, and custom candidates, plus
  desktop bootstrap requirements and blockers. They do not implement any
  transport or listener lifecycle. A local control transport trait boundary now
  names request/response exchanges, readiness reporting, and transport errors.
  It is synchronous and local-only; it does not implement a socket, HTTP
  server, WebSocket server, Tauri IPC command, remote pairing flow, or live
  subscription channel. A non-production in-process control client fixture now
  implements that trait with scripted responses and recorded exchanges. It
  proves local request/response carrying. A handler-backed in-process fixture
  now routes requests through `LocalControlRequestHandler` and proves read-only
  state queries plus command receipts through the transport boundary. It still
  does not implement Tauri IPC, network transport, socket listeners, state
  mutation execution, runtime execution, or background workers. Tauri IPC
  schema readiness types now name the first desktop command schema, control
  envelopes, and IPC blockers without implementing Tauri commands,
  serialization, or a desktop app.
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

## Apps

- `apps/nucleusd`: future server binary placeholder.
- `apps/desktop`: future Tauri client placeholder.

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
