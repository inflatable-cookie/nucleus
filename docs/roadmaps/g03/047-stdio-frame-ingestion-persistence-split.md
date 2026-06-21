# 047 Stdio Frame Ingestion Persistence Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/codex_supervision/stdio_frame_ingestion_persistence.rs`,
into focused support modules without changing Codex stdio frame ingestion
persistence behavior or granting provider write, callback, interruption,
recovery, SCM, forge, UI, or task mutation authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/006-harness-mediation-contract.md`
- `docs/contracts/018-task-agent-workflow-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move stdio frame ingestion persistence types/support code out of the
  front door where it reduces real pressure.
- [x] Move helper/test code into focused modules if needed.
- [x] Preserve persistence behavior and public type names.
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

- `batch-cards/154-stdio-frame-ingestion-persistence-type-split.md`
- `batch-cards/155-stdio-frame-ingestion-persistence-helper-test-split.md`
- `batch-cards/156-stdio-frame-ingestion-persistence-validation-closeout.md`

## Acceptance Criteria

- [x] The stdio frame ingestion persistence front door drops below the doctor
  error threshold.
- [x] Existing focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.

## Closeout Evidence

- `codex_supervision/stdio_frame_ingestion_persistence.rs` is now a 23-line
  front door with focused codec, event-builder, record-builder, store, test,
  and type modules.
- `cargo test -p nucleus-server stdio_frame_ingestion_persistence -- --nocapture`
  passed.
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- `effigy doctor` refreshed to 147 findings: 130 warnings and 17 errors.
