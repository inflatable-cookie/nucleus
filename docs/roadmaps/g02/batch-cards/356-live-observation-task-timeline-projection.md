# 356 Live Observation Task Timeline Projection

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../078-task-transition-admission-from-live-observations.md`

## Purpose

Project accepted live-observation transitions into task timeline entries.

## Scope

- Emit runtime progress timeline entries by reference.
- Include receipt, provider session, turn, checkpoint, and evidence refs when
  available.
- Keep timeline projection replay-only.

## Acceptance Criteria

- [ ] Accepted transitions produce deterministic timeline entries.
- [ ] Timeline entries do not contain raw provider material.
- [ ] Replay rebuilds the same timeline.
- [ ] Timeline projection grants no mutation authority.

## Validation

- `cargo test -p nucleus-server live_observation_task_timeline_projection -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
