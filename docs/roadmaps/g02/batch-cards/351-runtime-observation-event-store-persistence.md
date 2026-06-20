# 351 Runtime Observation Event Store Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../077-codex-runtime-observation-event-store-linkage.md`

## Purpose

Persist accepted runtime observations as orchestration event-store records.

## Scope

- Convert accepted observation records into event-store entries.
- Preserve receipt, session, frame, decode, and evidence refs.
- Block raw payload storage and task mutation.

## Acceptance Criteria

- [x] Accepted observations are persisted as events.
- [x] Rejected observations are represented as diagnostics/repair evidence.
- [x] Event persistence is idempotent.
- [x] Replay never re-runs provider effects.

## Validation

- `cargo test -p nucleus-server runtime_observation_event_store -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
