# Implementation Gap Index

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Track implementation gaps found during the stocktake.

This index separates missing product systems from cleanup work so the next
implementation lane can be chosen deliberately.

## Immediate Code Health Gaps

### God-File Pressure

Current state:

- `effigy doctor` no longer fails on `scan.god-files`
- the Codex task runtime high finding was split into focused runtime, type, and
  test modules
- `scan.god-files` still reports warning-sized files
- multiple warning-sized files are growing in server DTOs, request handlers,
  desktop Tauri code, desktop CSS, local store, and TypeScript control helpers

Needed:

- treat warning files as pressure when those areas are touched
- avoid adding more broad DTO or CSS surfaces until ownership is clearer

### Server Crate Accretion

Current state:

- `nucleus-server` owns host API, DTOs, local state, request handling, runtime
  readiness, command execution proof paths, scheduler vocabulary, and Tauri IPC
  helpers

Risk:

- the crate may become the engine by accident

Needed:

- introduce both `nucleus-engine` and `nucleus-orchestration`
- move domain logic out of host/server wrappers before provider runtime work

### Proof UI Growth

Current state:

- desktop panels are useful for diagnostics
- UI design direction is not settled
- TypeScript and CSS are already large enough to need splitting
- task work progress is now visible in the proof shell through read-only DTOs

Needed:

- keep UI as disposable proof surface
- stop adding panels until the core model has a stable workflow target
- split client helpers by domain if proof UI work continues

## Missing Runtime Systems

### Orchestration Runtime

Missing:

- command/event/projection store
- deterministic replay
- projection rebuilds
- command validators
- event identity and sequencing
- runtime reactors

Likely crate:

- new `nucleus-orchestration`, composed by `nucleus-engine`

### Harness Runtime

Missing:

- real provider adapters
- provider process/session runtime
- provider event ingestion
- provider command reactor
- cancellation
- permission prompts
- resume/recovery
- provider instance configuration and hot reload

Likely crates:

- `nucleus-agent-protocol`
- `nucleus-agent-adapters`
- possible runtime module under engine/server boundary

### SCM And Forge Runtime

Missing:

- SCM driver registry
- Git driver implementation
- Convergence adapter shape test
- forge provider registry
- provider discovery/auth
- branch/worktree/change-request workflows
- progress and conflict events

Likely crate:

- `nucleus-scm-forge`

### Management Projection Runtime

Current state:

- repo-backed project-management projection files exist for project, repo, and
  task records under `nucleus/`
- export writes deterministic TOML projection files
- import staging validates project/task projection files and preserves incoming
  records for review
- conflict detection and steward-assistance routing exist as non-mutating
  proof paths
- committable versus local-only policy is documented for first-pass records

Missing:

- explicit import-apply command boundary
- expected-revision and no-silent-overwrite gates during apply
- apply receipts and audit records
- client/steward read models for apply plans, conflicts, and repair proposals
- projection schema migration

Likely crates:

- `nucleus-projects`
- `nucleus-tasks`
- future planning/memory/research crates

### Remote Host Runtime

Missing:

- local socket or HTTP/WebSocket transport
- binary/client protocol decision
- pairing and auth
- host session store
- authority-map publication
- multi-host connection model

Likely crates:

- `nucleus-server`
- possible client protocol crate

### Workspace Runtime

Missing:

- terminal panels
- browser/preview panels
- editor panel backend
- SCM diff/commit panel backend
- layout persistence across clients
- tool broker between panels, harnesses, and host capabilities

Likely crates:

- `nucleus-workspaces`
- possible tool broker crate

### Planning, Memory, Research, And Effigy

Missing crates:

- `nucleus-memory`
- `nucleus-planning`
- `nucleus-research`
- `nucleus-effigy-integration`

Missing runtime:

- memory proposal/review flows
- guided project planning
- deep research runs and synthesis
- Effigy selector discovery, health summaries, and validation planning

## Suggested Next Implementation Gate

The orchestration decision has been made, the task-backed workflow proof has
validated a read-only progress path through fixtures, and repo-backed
management projection export/import/conflict staging has been hardened.

The most useful next code lane is likely:

1. keep warning-level god-file pressure visible as a health guardrail
2. add an explicit import-apply boundary for staged project/task projection
   records
3. prove expected-revision, invalid-record, unsupported-schema, and semantic
   conflict gates before active state can change
4. record sanitized apply receipts and expose review-ready sync state before
   steward automation, SCM capture/publish, or UI sync controls expand
