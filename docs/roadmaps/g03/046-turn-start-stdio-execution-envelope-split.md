# 046 Turn Start Stdio Execution Envelope Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the current top doctor error file,
`crates/nucleus-server/src/codex_supervision/turn_start_stdio_execution_envelope.rs`,
into focused support modules without changing Codex `turn/start` stdio
execution envelope behavior or granting provider write, callback,
interruption, recovery, SCM, forge, UI, or task mutation authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/006-harness-mediation-contract.md`
- `docs/contracts/018-task-agent-workflow-contract.md`
- `docs/roadmaps/g03/035-post-convergence-health-and-boundary-rebaseline.md`

## Goals

- [x] Move turn-start stdio envelope types/support code out of the front door
  where it reduces real pressure.
- [x] Move helper/test code into focused modules if needed.
- [x] Preserve envelope behavior and public type names.
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

- `batch-cards/151-turn-start-stdio-execution-envelope-type-split.md`
- `batch-cards/152-turn-start-stdio-execution-envelope-helper-test-split.md`
- `batch-cards/153-turn-start-stdio-execution-envelope-validation-closeout.md`

## Acceptance Criteria

- [x] The turn-start stdio execution envelope front door drops below the
  doctor error threshold.
- [x] Existing focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI panel, or task mutation behavior is added.

## Closeout Evidence

- `codex_supervision/turn_start_stdio_execution_envelope.rs` is now a 21-line
  front door with focused decision, test, and type modules.
- `cargo test -p nucleus-server turn_start_stdio_execution_envelope -- --nocapture`
  passed.
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server` passed.
- `effigy doctor` refreshed to 148 findings: 130 warnings and 18 errors.
