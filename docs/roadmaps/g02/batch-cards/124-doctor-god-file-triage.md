# 124 Doctor God File Triage

Status: ready
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

- Doctor failure is summarized in roadmap/docs.
- High split target is explicit.
- Warning files that should not grow during the next runway are named.

## Validation

- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if doctor output differs from the expected god-file failure.
