# 040 Selected Task Review Next Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../009-selected-task-review-next-step-presentation.md`

## Purpose

Define the read-only boundary for selected-task review readiness and
pathway-backed next-step presentation.

## Work

- [x] Name the source records allowed in the review/next-step read model.
- [x] Define review states and next-step categories for this product proof.
- [x] Define no-effect flags for review mutation, task mutation, provider
  execution, SCM/forge mutation, memory apply, planning apply, and UI effects.
- [x] Record stop conditions before server or desktop code changes.

## Acceptance Criteria

- [x] The lane can proceed without inventing review mutation controls.
- [x] Review acceptance remains separate from runtime completion and task
  completion.
- [x] Next-step output is tied to a known pathway or an explicit ambiguity.

## Result

- Selected-task review/next presentation is bounded to read-only summaries over
  task workflow drilldown evidence.
- Allowed source records are task identity, work items, runtime receipts,
  checkpoints, diffs, validation refs, timeline refs, review refs, task
  completion refs, SCM handoff refs, and existing next-step pathway refs.
- Review states are not-ready, awaiting-review, accepted, rejected,
  needs-changes, and abandoned.
- Next categories are review-evidence, rework, task-command, SCM-handoff,
  inspect-runtime, planning-ambiguity, and wait.
- No-effect posture reuses `TaskWorkflowNoEffects::read_only()`.
