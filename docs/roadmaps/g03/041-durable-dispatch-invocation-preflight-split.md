# 041 Durable Dispatch Invocation Preflight Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/provider_durable_dispatch_invocation_preflight.rs`,
into focused support modules without changing durable dispatch invocation
preflight behavior or granting provider-write authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/009-harness-runtime-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move durable dispatch invocation preflight types/support code out of the
  front door where it reduces real pressure.
- [x] Move blocker/helper/test code into focused modules if needed.
- [x] Preserve preflight behavior and public type names.
- [x] Avoid provider write, callback response, process spawn, SCM mutation,
  remote transport, UI, and task mutation behavior changes.

## Execution Plan

- [x] Type/support split batch.
- [x] Blocker/helper/test split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/136-durable-dispatch-invocation-preflight-type-split.md`
- `batch-cards/137-durable-dispatch-invocation-preflight-helper-test-split.md`
- `batch-cards/138-durable-dispatch-invocation-preflight-validation-closeout.md`

## Acceptance Criteria

- [x] The preflight front door drops below the doctor error threshold.
- [x] Existing focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.

## Closeout Evidence

- Front door: `crates/nucleus-server/src/provider_durable_dispatch_invocation_preflight.rs`
  is 76 lines.
- Focused tests: `cargo test -p nucleus-server durable_dispatch_invocation_preflight -- --nocapture`
  passed.
- Server check: `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- Doctor reports 152 findings: 129 warnings and 23 errors.
