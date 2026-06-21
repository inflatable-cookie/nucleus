# 141 Runtime Observation Event Store Persistence Validation Closeout

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../042-runtime-observation-event-store-persistence-split.md`

## Purpose

Validate the runtime observation event-store persistence split and refresh
health evidence.

## Acceptance Criteria

- [ ] Focused tests pass.
- [ ] `cargo check -p nucleus-server` passes.
- [ ] Doctor status is refreshed or remaining blockers are recorded.
- [ ] Roadmap front doors select the next bounded lane.
- [ ] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server runtime_observation_event_store_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
