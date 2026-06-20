# 354 Live Observation Work Item Candidates

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../078-task-transition-admission-from-live-observations.md`

## Purpose

Derive task work-item transition candidates from accepted live observations.

## Scope

- Map provider observations to candidate runtime states.
- Preserve work item, task, provider session, receipt, and evidence refs.
- Keep candidates advisory until admitted.

## Acceptance Criteria

- [ ] Running, waiting, completed, failed, cancelled, and recovery-required
      candidates can be represented.
- [ ] Missing work-item identity blocks candidate creation.
- [ ] Candidates do not mutate task state.
- [ ] Raw provider material is not copied.

## Validation

- `cargo test -p nucleus-server live_observation_work_item_candidates -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
