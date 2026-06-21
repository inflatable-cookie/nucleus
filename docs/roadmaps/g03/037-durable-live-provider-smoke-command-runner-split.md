# 037 Durable Live Provider Smoke Command Runner Split

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Split the error-sized durable live provider smoke command-runner file into
focused support modules without changing command behavior, provider behavior,
or live-write authority.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g03/036-control-envelope-request-boundary-split.md`

## Goals

- [x] Move model/support types out of
  `apps/nucleusd/src/command_runner/durable_live_provider_write_smoke.rs`.
- [x] Move helper/parsing/formatting code into focused modules if needed.
- [x] Preserve command behavior and public CLI output shape.
- [x] Avoid provider write, process spawn, SCM mutation, remote transport, UI,
  and task mutation behavior changes.

## Execution Plan

- [x] Model split batch.
- [x] Helper split batch.
- [x] Validation and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/124-durable-live-provider-smoke-model-split.md`
- `batch-cards/125-durable-live-provider-smoke-helpers-split.md`
- `batch-cards/126-durable-live-provider-smoke-validation-closeout.md`

## Closeout Evidence

- `durable_live_provider_write_smoke.rs` dropped from 541 code lines to 385.
- New focused modules:
  - `durable_live_provider_write_smoke/dispatch.rs`
  - `durable_live_provider_write_smoke/evidence.rs`
  - `durable_live_provider_write_smoke/labels.rs`
  - `durable_live_provider_write_smoke/test_support.rs`
- `cargo test -p nucleusd durable_live_provider_write_smoke -- --nocapture`
  passed.
- `CARGO_INCREMENTAL=0 cargo check -p nucleusd` passed.
- `effigy doctor` remains red but error findings dropped from 28 to 27.

## Acceptance Criteria

- [x] The command-runner durable live provider smoke front door drops below the
  doctor error threshold.
- [x] Existing tests pass.
- [x] `cargo check -p nucleusd` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI
  panel, or task mutation behavior is added.
