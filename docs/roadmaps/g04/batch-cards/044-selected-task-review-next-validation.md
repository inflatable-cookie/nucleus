# 044 Selected Task Review Next Validation

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../009-selected-task-review-next-step-presentation.md`

## Purpose

Validate selected-task review/next-step presentation and choose the next
product workflow lane.

## Work

- [x] Run focused server, CLI, DTO, and desktop guard tests.
- [x] Run desktop check, workspace check, docs QA, Northstar QA, diff
  whitespace, and doctor.
- [x] Compare remaining gaps against the g04 runway.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] Review readiness and pathway-backed next-step state are visible without
  mutation authority.
- [x] The next product lane is bounded and follows the generation runway.

## Result

Validation passed for the selected-task review/next-step lane:

- focused server selected-task review/next tests
- focused `nucleusd` selected-task review/next tests
- desktop panel guard tests
- `effigy server:query:selected-task-review-next`
- `effigy desktop:check`
- `cargo check --workspace`
- docs QA and Northstar QA
- diff whitespace check
- `effigy doctor`, warning-only

The next g04 lane is selected-task SCM handoff readiness. This follows the
generation runway item for practical SCM readiness handoff without provider
execution or SCM/forge mutation.
