# 206 Current God File Report Normalization

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../045-god-file-health-gate-rebaseline.md`

## Purpose

Normalize the current `effigy doctor` god-file report into the docs.

## Scope

- Record the six current error files.
- Record warning pressure only as secondary context.
- Do not edit Rust code.

## Acceptance Criteria

- The implementation audit matches `.effigy/reports/doctor/scan-god-files.md`.
- The next split order can be derived from docs without rerunning analysis.

## Validation

- `effigy qa:docs`
- `git diff --check`

## Stop Conditions

- Stop if `effigy doctor` changes the error set before split work begins.
