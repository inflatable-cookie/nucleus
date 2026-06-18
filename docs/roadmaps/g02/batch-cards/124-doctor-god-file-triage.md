# 124 Doctor God File Triage

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Capture the current `effigy doctor` god-file failure and identify the exact
split required before runtime work continues.

## Scope

- Read `.effigy/reports/doctor/scan-god-files.md`.
- Identify high findings and relevant warning pressure.
- Name split targets for command policy, server DTOs, and desktop proof files.
- Do not refactor code in this card.

## Acceptance Criteria

- [x] Doctor failure is summarized in roadmap/docs.
- [x] High split target is explicit.
- [x] Warning files that should not grow during the next runway are named.

## Result

`effigy doctor` reported 42 god-file findings before the reset:
12 errors and 30 warnings. The high findings were no longer the stale
command-policy codec target; they were concentrated in native harness Effigy
support, server diagnostics/control DTO surfaces, runtime supervision,
engine management projections, task work-item state, steward command records,
and the desktop control helper.

## Validation

- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if doctor output differs from the expected god-file failure.
