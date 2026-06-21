# 048 Durable Executor Dispatch Admission Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/provider_durable_executor_dispatch_admission.rs`,
into focused support modules without changing durable executor dispatch
admission behavior or granting provider write, callback, interruption,
recovery, SCM, forge, UI, or task mutation authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/006-harness-mediation-contract.md`
- `docs/contracts/018-task-agent-workflow-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move durable executor dispatch admission types/support code out of the
  front door where it reduces real pressure.
- [x] Move helper/test code into focused modules if needed.
- [x] Preserve admission behavior and public type names.
- [x] Avoid provider write, callback response, process spawn, SCM mutation,
  remote transport, UI, and task mutation behavior changes.

## Execution Plan

- [x] Type/support split batch.
- [x] Helper/test split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/157-durable-executor-dispatch-admission-type-split.md`
- `batch-cards/158-durable-executor-dispatch-admission-helper-test-split.md`
- `batch-cards/159-durable-executor-dispatch-admission-validation-closeout.md`

## Acceptance Criteria

- [x] The durable executor dispatch admission front door drops below the doctor
  error threshold.
- [x] Existing focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.

## Evidence

- `provider_durable_executor_dispatch_admission.rs` is now a small front door
  over focused type, helper, blocker, record-builder, and test modules.
- The health batch also externalized remaining inline server test modules,
  split broad export front doors, and split recovery execution validators.
- `effigy doctor` exits successfully with 137 god-file warnings and zero
  errors.
- `CARGO_INCREMENTAL=0 cargo test -p nucleus-server` passes.
