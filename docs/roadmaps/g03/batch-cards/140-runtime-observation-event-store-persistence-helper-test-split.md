# 140 Runtime Observation Event Store Persistence Helper Test Split

Status: planned
Owner: Tom
Updated: 2026-06-21
Milestone: `../042-runtime-observation-event-store-persistence-split.md`

## Purpose

Move runtime observation event-store persistence codec/helper/test code into
focused modules if needed after the type/support split.

## Acceptance Criteria

- [ ] Helper/test code is split only where it reduces real pressure.
- [ ] Persistence behavior remains unchanged.
- [ ] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server runtime_observation_event_store_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
