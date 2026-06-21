# 045 Turn Start Executor Smoke Boundary Split

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/codex_supervision/turn_start_executor_smoke_boundary.rs`,
into focused support modules without changing Codex turn-start smoke behavior
or granting provider write, callback, interruption, recovery, SCM, forge, UI,
or task mutation authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/006-harness-mediation-contract.md`
- `docs/contracts/018-task-agent-workflow-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [ ] Move turn-start smoke boundary types/support code out of the front door
  where it reduces real pressure.
- [ ] Move helper/test code into focused modules if needed.
- [ ] Preserve smoke boundary behavior and public type names.
- [ ] Avoid provider write, callback response, process spawn, SCM mutation,
  remote transport, UI, and task mutation behavior changes.

## Execution Plan

- [ ] Type/support split batch.
- [ ] Helper/test split batch.
- [ ] Validation and closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/148-turn-start-executor-smoke-boundary-type-split.md`

Planned cards:

- `batch-cards/149-turn-start-executor-smoke-boundary-helper-test-split.md`
- `batch-cards/150-turn-start-executor-smoke-boundary-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] The turn-start executor smoke boundary front door drops below the doctor
  error threshold.
- [ ] Existing focused tests pass.
- [ ] `cargo check -p nucleus-server` passes.
- [ ] Doctor status is refreshed or remaining blockers are recorded.
- [ ] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.
