# 003 Engine Task Command Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Move task command mutation out of request-handler code and into the portable
engine boundary.

`g02/001` proved the engine/orchestration crate split. `g02/002` hardened the
first event-store persistence path. This milestone makes task command handling
follow that architecture: host request handlers should adapt client requests,
then call engine services. They should not own domain mutation rules.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/architecture/engine-orchestration-boundary.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define an engine-owned task command service boundary.
- [x] Keep request-handler code as host/API adaptation only.
- [x] Route task create and activity transition mutation through the engine.
- [x] Preserve orchestration command admission and event-store append before
  mutation.
- [x] Preserve existing task DTO/query behavior.
- [x] Keep provider runtime, SCM mutation, UI work, and remote transport out of
  scope.

## Execution Plan

- [x] Engine service batch: move task command mutation vocabulary and service
  shape into `nucleus-engine`.
- [x] Mutation coverage batch: add focused tests for create, update, and
  activity transitions through the engine service.
- [x] Host delegation batch: make request-handler task commands delegate to the
  engine service while preserving receipts.
- [x] Validation batch: run focused engine/server tests, workspace compile, and
  Northstar checks; close the milestone.

## Acceptance Criteria

- [x] Task command mutation rules no longer live primarily in
  `request_handler` modules.
- [x] Request handlers translate command DTOs, call engine services, and map
  receipts/errors back to control responses.
- [x] Existing task command behavior stays compatible for the disposable UI and
  `nucleusd` proof surfaces.
- [x] Orchestration command admission and event append still happen before
  observable task mutation.
- [x] `cargo check --workspace`, focused engine/server tests,
  `effigy qa:docs`, and `effigy qa:northstar` pass.

## Stop Conditions

- The migration requires changing public task semantics before the task
  contract is updated.
- The engine service starts depending on `nucleus-server`, Tauri, local socket
  transport, or UI DTOs.
- The milestone starts implementing timeline projections, provider runtime, or
  SCM workflows.

## Cards

- `batch-cards/005-engine-task-command-service.md`
- `batch-cards/006-task-command-admission-and-mutation-tests.md`
- `batch-cards/007-request-handler-task-command-delegation.md`
- `batch-cards/008-engine-task-command-validation.md`

## Outcome

- Added `EngineTaskCommandService` in `nucleus-engine`.
- Added engine-owned task command input, update, transition, result, error,
  record, revision expectation, and repository trait types.
- Moved task create, update, and activity transition mutation rules into the
  engine service.
- Replaced server request-handler mutation logic with command DTO mapping,
  local-store repository adaptation, and engine error-to-receipt mapping.
- Preserved task command admission and event-store append before task mutation.
- Added focused engine tests for create, update, transition, and invalid
  agent-ready task rejection.
