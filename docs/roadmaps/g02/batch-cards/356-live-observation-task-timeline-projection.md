# 356 Live Observation Task Timeline Projection

Status: completed
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

- [x] Accepted transitions produce deterministic timeline entries.
- [x] Timeline entries do not contain raw provider material.
- [x] Replay rebuilds the same timeline.
- [x] Timeline projection grants no mutation authority.

## Validation

- `cargo test -p nucleus-server live_observation_task_timeline_projection -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
