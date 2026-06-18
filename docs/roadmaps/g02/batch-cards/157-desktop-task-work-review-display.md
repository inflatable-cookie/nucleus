# 157 Desktop Task Work Review Display

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../035-desktop-task-agent-progress-proof.md`

## Purpose

Display task work-unit review state in the disposable desktop proof shell.

## Scope

- Show checkpoint refs, diff refs, review state, and source summaries.
- Keep accept/reject controls absent.
- Preserve no-SCM-mutation posture.

## Acceptance Criteria

- Review state is visible.
- Checkpoint/diff refs are inspectable.
- Desktop cannot accept or mutate work.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if review display needs real SCM actions.

## Result

- Displayed review state separately from runtime state.
- Surfaced checkpoint and diff refs in the selected work-unit detail view.
- Kept accept, reject, and SCM mutation controls absent.
