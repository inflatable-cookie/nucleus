# 342 Durable Dispatch Outcome Persistence

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../075-codex-durable-dispatch-invocation-gate.md`

## Purpose

Persist or link durable dispatch invocation outcomes through sanitized outcome,
receipt, and durable status records.

## Scope

- Reuse Codex live executor outcome persistence and durable dispatch outcome
  linkage.
- Preserve failure, timeout, blocked, cleanup-required, accepted, and completed
  states.
- Keep task/review/callback/interruption/recovery/SCM authority out of outcome
  persistence.

## Acceptance Criteria

- [ ] Invocation outcome persistence writes only sanitized records.
- [ ] Duplicate write-attempt ids are rejected deterministically.
- [ ] Durable status records reflect linked invocation outcomes.
- [ ] Outcome persistence does not mutate task state.

## Validation

- `cargo test -p nucleus-server durable_dispatch_outcome_persistence -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
