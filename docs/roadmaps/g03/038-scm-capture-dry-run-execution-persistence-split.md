# 038 SCM Capture Dry Run Execution Persistence Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the error-sized SCM capture dry-run execution persistence file into
focused support modules without changing persistence behavior, SCM behavior, or
provider authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/roadmaps/g03/037-durable-live-provider-smoke-command-runner-split.md`

## Goals

- [x] Move record/model support code out of
  `crates/nucleus-server/src/provider_scm_capture_dry_run_execution_persistence.rs`.
- [x] Move helper/read-write support code into focused modules if needed.
- [x] Preserve persistence behavior and public type names.
- [x] Avoid provider write, process spawn, SCM mutation, remote transport, UI,
  and task mutation behavior changes.

## Execution Plan

- [x] Record split batch.
- [x] Helper split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/127-scm-capture-dry-run-execution-persistence-record-split.md`
- `batch-cards/128-scm-capture-dry-run-execution-persistence-helper-split.md`
- `batch-cards/129-scm-capture-dry-run-execution-persistence-validation-closeout.md`

## Acceptance Criteria

- [x] The persistence front door drops below the doctor error threshold.
- [x] Existing tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI
  panel, or task mutation behavior is added.

## Closeout Evidence

- Front door: `crates/nucleus-server/src/provider_scm_capture_dry_run_execution_persistence.rs`
  is 103 lines.
- Focused tests: `cargo test -p nucleus-server scm_capture_dry_run_execution_persistence -- --nocapture`
  passed.
- Server check: `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- Doctor after the broader health batch reports 154 findings: 129 warnings and
  25 errors.
