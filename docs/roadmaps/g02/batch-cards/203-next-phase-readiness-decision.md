# 203 Next Phase Readiness Decision

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../044-scm-workflow-closeout-and-next-phase-selection.md`

## Purpose

Select the next implementation phase from the long-term plan.

## Scope

- Compare candidate phases: harness runtime, steward depth, remote transport,
  workspace panels, planning/memory/research.
- Record the chosen phase and rejected alternatives.
- Do not create implementation cards until the decision is grounded.

## Acceptance Criteria

- One next phase is selected with rationale.
- Planning gaps are explicit.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if no candidate phase has enough contract support.
