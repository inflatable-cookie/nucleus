# 043 Completion SCM Capture Preparation Persistence Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/provider_completion_scm_capture_preparation_persistence.rs`,
into focused support modules without changing completion SCM capture
preparation persistence behavior or granting SCM/provider/task authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move completion SCM capture preparation persistence types/support code
  out of the front door where it reduces real pressure.
- [x] Move codec/helper/test code into focused modules if needed.
- [x] Preserve persistence behavior and public type names.
- [x] Avoid provider write, callback response, process spawn, SCM mutation,
  remote transport, UI, and task mutation behavior changes.

## Execution Plan

- [x] Type/support split batch.
- [x] Codec/helper/test split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/142-completion-scm-capture-preparation-persistence-type-split.md`
- `batch-cards/143-completion-scm-capture-preparation-persistence-helper-test-split.md`
- `batch-cards/144-completion-scm-capture-preparation-persistence-validation-closeout.md`

## Acceptance Criteria

- [x] The completion SCM capture preparation persistence front door drops below
  the doctor error threshold.
- [x] Existing focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.

## Closeout Evidence

- Front door: `crates/nucleus-server/src/provider_completion_scm_capture_preparation_persistence.rs`
  is 118 lines.
- Focused tests: `cargo test -p nucleus-server completion_scm_capture_preparation_persistence -- --nocapture`
  passed.
- Server check: `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- Doctor reports 150 findings: 129 warnings and 21 errors.
