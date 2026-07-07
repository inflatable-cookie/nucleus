# 035 Selected Task Command Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../007-selected-task-command-admission-controls.md`

## Purpose

Validate selected-task command admission and choose the next product lane.

## Work

- [x] Run focused task-command admission tests.
- [x] Run CLI/Effigy checks.
- [x] Run desktop proof checks.
- [x] Run docs QA, Northstar QA, formatting, package checks, diff whitespace,
  and doctor.
- [x] Compare remaining gaps against deferred lanes and the g04 runway.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The product can move from selected-task evidence to explicit task-only
  command mutation.
- [x] The next lane is bounded and product-significant.

## Result

- Validation passed for selected-task command admission, CLI/Effigy inspection,
  desktop proof controls, docs QA, Northstar QA, formatting, workspace check,
  and doctor.
- Doctor is warning-only for known god-file findings.
- Next lane: task-command outcome coherence. After a task-only command, the
  client must refresh server-owned task state, workflow drilldown, timeline,
  command receipt, and next-step context without guessing locally.
