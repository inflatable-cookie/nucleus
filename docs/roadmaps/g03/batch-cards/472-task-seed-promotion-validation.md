# 472 Task Seed Promotion Validation

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Validate the task seed promotion lane.

## Work

- [x] Run focused engine/server/CLI tests.
- [x] Run focused crate checks.
- [x] Run Effigy diagnostics smoke.
- [x] Run docs QA, Northstar QA, diff check, and doctor.

## Acceptance Criteria

- [x] Tests pass.
- [x] Effigy smoke passes.
- [x] Doctor has zero errors.

## Result

- Focused engine, server, and CLI tests pass.
- Focused server and `nucleusd` crate checks pass.
- `effigy server:query:task-seed-promotion-diagnostics` passes and reports
  read-only/no-effect flags.
- Docs QA, Northstar QA, diff check, and doctor pass; doctor remains
  warning-only with zero errors.
