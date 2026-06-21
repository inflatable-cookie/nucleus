# 126 Durable Live Provider Smoke Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../037-durable-live-provider-smoke-command-runner-split.md`

## Purpose

Validate the durable live provider smoke command-runner split and update health
evidence.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] `cargo check -p nucleusd` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] Roadmap front doors select the next bounded lane.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI, or
  task behavior is added.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_smoke -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleusd`
- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
