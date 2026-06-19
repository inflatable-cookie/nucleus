# 045 God File Health Gate Rebaseline

Status: active
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

- [ ] Capture the current red files.
- [ ] Pick a split order based on risk and dependency pressure.
- [ ] Keep behavior unchanged during health repair.

## Execution Plan

- [ ] Report batch: normalize the current doctor evidence.
- [ ] Risk batch: map split order and validation by crate.

## Batch Cards

Ready cards:

- `batch-cards/206-current-god-file-report-normalization.md`

Planned cards:

- `batch-cards/207-god-file-split-order-and-risk-map.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] The six current error files are listed with intended split targets.
- [ ] Validation commands are scoped by crate.
- [ ] The next code split card is ready.

## Gate

Do not start broad runtime work until this health gate defines the split order.
