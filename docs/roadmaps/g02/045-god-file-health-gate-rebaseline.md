# 045 God File Health Gate Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Rebaseline the current red `effigy doctor` god-file report and set a safe split
order before touching code.

## Governing Refs

- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/logs/2026-06-19-scm-runway-closeout.md`
- `.effigy/reports/doctor/scan-god-files.md`

## Goals

- [x] Capture the current red files.
- [x] Pick a split order based on risk and dependency pressure.
- [x] Keep behavior unchanged during health repair.

## Execution Plan

- [x] Report batch: normalize the current doctor evidence.
- [x] Risk batch: map split order and validation by crate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/206-current-god-file-report-normalization.md`
- `batch-cards/207-god-file-split-order-and-risk-map.md`

## Acceptance Criteria

- [x] The six current error files are listed with intended split targets.
- [x] Validation commands are scoped by crate.
- [x] The next code split card is ready.

## Result

The red god-file split order is documented. The first code split target was
management projection state tests, followed by SCM work sessions.

## Gate

Do not start broad runtime work until this health gate defines the split order.
