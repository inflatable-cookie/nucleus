# 352 Runtime Observation Replay Projection

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../077-codex-runtime-observation-event-store-linkage.md`

## Purpose

Rebuild runtime observation projections from persisted event-store records.

## Scope

- Project session progress, wait states, terminal states, repair needs, and
  evidence refs.
- Preserve unsupported observations in diagnostics.
- Keep projection read-only.

## Acceptance Criteria

- [ ] Projection rebuild is deterministic.
- [ ] Terminal and wait states survive replay.
- [ ] Unsupported observations remain visible.
- [ ] Projection grants no provider or task authority.

## Validation

- `cargo test -p nucleus-server runtime_observation_replay_projection -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
