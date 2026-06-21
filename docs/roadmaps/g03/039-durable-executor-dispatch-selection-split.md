# 039 Durable Executor Dispatch Selection Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the error-sized durable executor dispatch selection file into focused
support modules without changing dispatch-selection behavior, provider
authority, or task/SCM behavior.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/009-harness-runtime-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move dispatch selection types out of the front door.
- [x] Move blocker logic into a focused module.
- [x] Move tests into a focused module.
- [x] Preserve public type names and dispatch-selection behavior.
- [x] Avoid provider write, process spawn, SCM mutation, remote transport, UI,
  and task mutation behavior changes.

## Execution Plan

- [x] Type and blocker split batch.
- [x] Test split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/130-durable-executor-dispatch-selection-type-split.md`
- `batch-cards/131-durable-executor-dispatch-selection-blocker-test-split.md`
- `batch-cards/132-durable-executor-dispatch-selection-validation-closeout.md`

## Acceptance Criteria

- [x] The dispatch-selection front door drops below the doctor error threshold.
- [x] Existing tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI
  panel, or task mutation behavior is added.

## Closeout Evidence

- Front door: `crates/nucleus-server/src/provider_durable_executor_dispatch_selection.rs`
  is 79 lines.
- Focused tests: `cargo test -p nucleus-server durable_executor_dispatch_selection -- --nocapture`
  passed.
- Server check: `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- Doctor reports 154 findings: 129 warnings and 25 errors.
