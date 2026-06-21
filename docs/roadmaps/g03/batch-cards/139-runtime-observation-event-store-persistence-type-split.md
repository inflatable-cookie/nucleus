# 139 Runtime Observation Event Store Persistence Type Split

Status: ready
Owner: Tom
Updated: 2026-06-21
Milestone: `../042-runtime-observation-event-store-persistence-split.md`

## Purpose

Move runtime observation event-store persistence type/support code out of the
front door.

## Acceptance Criteria

- [ ] Type/support code moves only where it reduces real front-door pressure.
- [ ] Public type names and persistence behavior remain unchanged.
- [ ] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server runtime_observation_event_store_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
