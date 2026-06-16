# 006 Server Local State Implementation Runway

Status: complete
Owner: Tom
Updated: 2026-06-16

## Goal

Build the first real implementation slice: server-local durable state for
projects, tasks, workspaces, adapter registry records, sessions, server
events, command evidence metadata, artifact metadata, runtime effect refs,
shared memory records, structured project planning records, and deep research
records, plus optional project tool integration records.

This is the substrate for later control planes, harness adapters, command
execution, SCM panels, editor panels, and native steward workflows.

## Scope

- Add a server-local storage crate or module boundary.
- Keep storage backend-adapter based so SQLite local deployments and future
  centralized PostgreSQL or remote database deployments share domain
  repository traits.
- Define repository traits and conformance tests for durable server records.
- Use SQLite as the first local durable backend.
- Use `serde`-based record serialization at storage edges.
- Keep repo-backed project projection separate from active server-local state.
- Add restart-recovery tests for the first persisted domains.
- Keep implementation modular; avoid putting storage logic into `lib.rs`.
- Include shared memory and structured planning in the first storage boundary
  vocabulary before schemas settle.
- Include deep research records in the first storage boundary vocabulary
  before schemas settle.
- Include optional project tool integration records in the first storage
  boundary vocabulary before schemas settle.

## Out Of Scope

- Tauri UI.
- Web/mobile/CLI control planes.
- Live harness adapters.
- Command execution.
- Runtime scheduler.
- Live subscriptions.
- Remote auth and LAN/internet pairing.
- Secret backend implementation.
- Artifact payload storage.
- Text/code editor implementation.
- SCM diff/commit panel implementation.

## Decisions

- First implementation slice: server-local durable state.
- First backend: SQLite embedded in the server data root.
- Backend posture: adapter-based from the start. SQLite is the first local
  backend, not the permanent assumption for team deployments.
- First serialization posture: typed Rust records with `serde`; database rows
  store stable ids, record kind, revision, timestamps where available, and
  structured payloads where a normalized table is not yet justified.
- First control API: defer. The implementation can expose Rust repository
  services and tests before HTTP/WebSocket/local socket API is chosen.
- First auth posture: defer. Local-only auth policy remains a contract topic
  until a client API exists.
- Editor and SCM panels: defer implementation. Their contracts now exist, but
  they do not block server-local state.

## Execution Plan

- [x] Define server-local storage crate shape and dependency posture.
- [x] Add storage error, transaction, revision, and repository trait
  vocabulary.
- [x] Add in-memory conformance test fixtures before SQLite behavior.
- [x] Add SQLite-backed storage implementation for project/task/workspace
  records.
- [x] Add shared memory and structured planning records to the first persisted
  domain vocabulary before storage schemas settle.
- [x] Add deep research records to the first persisted domain vocabulary
  before storage schemas settle.
- [x] Add project tool integration records, including Effigy integration
  metadata, to the first persisted domain vocabulary before storage schemas
  settle.
- [x] Add adapter registry and session record persistence.
- [x] Add event journal, command evidence metadata, artifact metadata, and
  runtime effect ref persistence.
- [x] Add restart-recovery tests across the first persisted domains.
- [x] Reassess API, auth, Tauri, and runtime scheduler sequencing after the
  storage slice passes.

## Acceptance Criteria

- [x] Server-local storage has a clear crate/module boundary.
- [x] Repository traits are small and domain-oriented.
- [x] SQLite is isolated behind storage interfaces.
- [x] Storage backend selection does not leak SQLite assumptions into domain
  repository traits.
- [x] Tests prove records survive restart for first persisted domains.
- [x] Projection state is not treated as the active server database.
- [x] Secrets, raw command output, provider transcripts, private memories,
  unreviewed planning transcripts, raw research source payloads, and artifact
  payloads are not persisted in normal server state.
- [x] No Tauri, harness adapter, command runner, or remote auth behavior is
  introduced.

## Cards

- `docs/roadmaps/g01/batch-cards/070-define-server-local-storage-crate-shape.md`
- `docs/roadmaps/g01/batch-cards/071-add-storage-traits-and-error-vocabulary.md`
- `docs/roadmaps/g01/batch-cards/072-add-storage-conformance-fixtures.md`
- `docs/roadmaps/g01/batch-cards/073-add-sqlite-project-task-workspace-storage.md`
- `docs/roadmaps/g01/batch-cards/074-add-adapter-registry-session-storage.md`
- `docs/roadmaps/g01/batch-cards/075-add-event-and-runtime-metadata-storage.md`
- `docs/roadmaps/g01/batch-cards/076-add-storage-restart-recovery-tests.md`
- `docs/roadmaps/g01/batch-cards/077-draft-shared-memory-and-project-planning-boundaries.md`
- `docs/roadmaps/g01/batch-cards/078-draft-deep-research-boundary.md`
- `docs/roadmaps/g01/batch-cards/079-draft-effigy-project-integration-boundary.md`

## Closeout

The first server-local storage implementation slice is complete. It gives the
server a backend-adapter-shaped local state substrate, SQLite restart recovery
for the first active domains, and explicit vocabulary for memory, planning,
research, and project tooling records before their schemas settle.

The next lane is server control API and runtime sequencing. Tauri, remote
auth, command execution, and provider runtime behavior stay deferred until
server-owned command/query boundaries exist.

## Deferred Lanes

- Editor and SCM panel implementation. Contract/card `069` remains proposed.
- Control API and auth implementation.
- Runtime scheduler and command execution.
- Provider adapters.
- Memory extraction, embeddings, and semantic search.
- Structured planning UI and prompt/template system.
- Deep research crawler, browser automation, source retrieval, and citation UI.
- Effigy tool bridge, harness skill injection, manifest editing UI, and
  command execution.
- Artifact payload backend.
- Secret backend.
