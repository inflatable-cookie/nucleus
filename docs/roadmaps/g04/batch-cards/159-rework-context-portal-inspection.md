# 159 Rework Context Portal Inspection

Status: completed
Owner: Codex
Updated: 2026-07-11
Milestone: `../030-review-guided-rework-execution.md`
Auto-start next card: yes

## Objective

Expose the current durable review outcome, note, and provenance through the
existing task-scoped `task_workflow inspect` response.

## Scope

- compose one canonical selected-task rework context from durable decisions
- expose outcome, reason, decision ref, reviewed work refs, and evidence refs
- distinguish rework-ready, accepted, absent, and inconsistent states
- add no tool and perform no mutation or provider execution

## Acceptance Criteria

- inspection returns the note the operator can already see in Diff
- only current task/project decisions are eligible
- response contains refs, not patch bytes or provider transcript
- existing non-reviewed task inspection remains compatible

## Validation

- focused local Codex chat tests
- `cargo fmt --all -- --check`
- `git diff --check`

## Next

Auto-start card 160 when inspection is source-backed and unambiguous.

## Outcome

- Task inspection now returns the current persisted review outcome, note,
  decision ref, reviewed work refs, evidence refs, and rework readiness.
- Selection is project/task scoped and ignores blocked decision records.
- Inspection remains read-only and contains no patch or provider payload.
