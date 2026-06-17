# 007 Management Projection Sync Foundation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Begin the committable project-management state model: project docs, tasks,
accepted planning artifacts, accepted memory, and accepted research synthesis
as repo-backed projection files.

## Governing Refs

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`

## Goals

- [x] Define management projection file ownership and schema boundaries.
- [x] Implement export of a minimal project/task projection.
- [x] Implement import validation without silent overwrite.
- [x] Keep live runtime state, secrets, local caches, and raw provider state out
  of projection files.
- [x] Preserve adapter-based SCM assumptions.

## Execution Plan

- [x] Schema batch: define first projection file names, record envelopes, and
  validation statuses.
- [x] Export batch: plan project/task projection files from authoritative
  state without writing files.
- [x] Import batch: validate and stage projection files without applying
  unsafe mutations.
- [x] Conflict batch: surface schema and semantic conflicts separately.

## Acceptance Criteria

- [x] A project/task management projection can be planned for repository
  export.
- [x] A fresh clone can validate projection envelopes before import.
- [x] Invalid and unsupported records are preserved and reported.
- [x] No runtime streams, secrets, or provider auth material are projected.

## Gate

Do not start until task timeline and checkpoint provenance are clear enough to
avoid projecting unstable runtime internals.

## Ready Cards

- `batch-cards/021-management-projection-schema-envelope.md`
- `batch-cards/022-minimal-project-task-projection-export.md`
- `batch-cards/023-management-projection-import-validation.md`
- `batch-cards/024-management-projection-conflict-reporting.md`

## Outcome

Completed the first management projection sync foundation.

Implemented:

- `nucleus-engine` management projection schema envelope and file refs.
- in-memory project/task export plans for repo-backed management files.
- validation report vocabulary for valid, warning, invalid, and unsupported
  schema outcomes.
- excluded-state markers so local UI layout, runtime streams, provider auth,
  terminal/browser state, caches, and secrets stay out of shared projection
  plans.
- schema and semantic conflict report vocabulary.
- `nucleus-server` helper that reads stored project/task records and builds an
  export plan without writing files or invoking SCM.

Deferred:

- TOML parsing/serialization.
- filesystem writes.
- import mutation.
- migration planning.
- SCM adapter integration.
- steward sync automation.
