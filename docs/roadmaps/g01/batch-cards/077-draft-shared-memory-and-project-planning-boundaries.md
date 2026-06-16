# 077 Draft Shared Memory And Project Planning Boundaries

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add first-pass authority surfaces for shared memory and structured project
planning before server-local storage implementation starts.

## Scope

- Define shared memory as server-owned project context.
- Define structured planning as server-owned project backbone state.
- Separate proposals from accepted authority.
- Separate active server state from committable projection.
- Update project, task, architecture, and storage docs so implementation
  accounts for these domains.

## Out Of Scope

- Memory extraction implementation.
- Embeddings or semantic search.
- Provider-native memory sync.
- Planning wizard UI.
- Prompt/template runtime.
- Storage schema implementation.

## Promotion Targets

- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/roadmaps/g01/006-server-local-state-implementation-runway.md`

## Closeout

Shared memory and structured planning are now documented as first-class
server-owned domains.

The next implementation runway can include their record boundaries without
building extraction, search, planning UI, or prompt orchestration yet.
