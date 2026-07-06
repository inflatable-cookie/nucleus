# 019 Review SCM Handoff Gap Presentation

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../004-selected-task-work-loop-composition.md`

## Purpose

Show review and SCM handoff gaps as product evidence, not as hidden missing
implementation.

## Work

- [ ] Map review refs, review statuses, SCM readiness refs, and SCM handoff
  refs already available to the selected task.
- [ ] Present missing review or SCM handoff as explicit gaps with safe next
  action text.
- [ ] Keep forge, SCM, commit, push, PR, merge, snapshot, and publish execution
  out of scope.
- [ ] Add focused tests for gap rendering and no mutation controls.

## Acceptance Criteria

- [ ] A selected task can explain why review or SCM handoff is unavailable.
- [ ] The proof avoids fake readiness.
- [ ] No SCM or forge mutation path is introduced.
