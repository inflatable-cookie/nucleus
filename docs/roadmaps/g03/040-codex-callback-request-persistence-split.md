# 040 Codex Callback Request Persistence Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/codex_supervision/callback_request_persistence.rs`,
into focused support modules without changing Codex callback request
persistence behavior or granting callback-response/provider authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/009-harness-runtime-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move callback request persistence types/support code out of the front
  door where it reduces real pressure.
- [x] Move persistence helper code into focused modules if needed.
- [x] Preserve callback request persistence behavior and public type names.
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

- `batch-cards/133-codex-callback-request-persistence-type-split.md`
- `batch-cards/134-codex-callback-request-persistence-helper-test-split.md`
- `batch-cards/135-codex-callback-request-persistence-validation-closeout.md`

## Acceptance Criteria

- [x] The callback request persistence front door drops below the doctor error
  threshold.
- [x] Existing focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.

## Closeout Evidence

- Front door: `crates/nucleus-server/src/codex_supervision/callback_request_persistence.rs`
  is 74 lines.
- Focused tests: `cargo test -p nucleus-server callback_request_persistence -- --nocapture`
  passed.
- Server check: `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- Doctor reports 153 findings: 129 warnings and 24 errors.
