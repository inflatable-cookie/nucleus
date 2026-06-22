# 161 God-File Warning Pressure Triage

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../049-doctor-green-health-closeout-and-next-lane-selection.md`

## Purpose

Classify remaining god-file warnings as touch-when-needed pressure rather than
an unbounded cleanup queue.

## Acceptance Criteria

- [x] Warning pressure is summarized by ownership area.
- [x] No broad warning-only split lane is opened without product value.
- [x] Future implementation lanes inherit the rule to split warning files when
  they are touched.

## Validation

- `effigy doctor`
- `git diff --check`
