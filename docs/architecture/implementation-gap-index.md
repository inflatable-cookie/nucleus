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

Missing:

- repo-backed project-management projection files
- import/export
- conflict detection
- steward-assisted sync policy
- projection schema migration
- clear policy separating committable task/project/planning state from
  local-only runtime progress, provider state, and UI layout

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

The orchestration decision has been made and the task-backed workflow proof has
validated a read-only progress path through fixtures.

The most useful next code lane is likely:

1. keep the high god-file doctor failure visible as a health gate
2. harden repo-backed management projection for task/project files
3. define local-only versus committable task-management records
4. prove export/import/conflict behavior before more provider runtime work
