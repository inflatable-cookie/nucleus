# 080 Effigy Doctor Summary Command

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../020-effigy-command-backed-inspection.md`

## Purpose

Map read-only Effigy doctor evidence into health summaries.

## Scope

- Add doctor command summary records.
- Represent ok, warning, error, blocked, and unknown status.
- Link repair hints and runtime receipts.

## Acceptance Criteria

- [x] Doctor summaries are sanitized and reference-backed.
- [x] Repair hints can cite doctor evidence.
- [x] Health status does not imply project mutation.

## Outcome

- Added doctor command summary records that wrap health summaries.
- Preserved repair hints and receipt-backed evidence.
- Confirmed doctor summaries do not mutate project state or retain raw output.

## Validation

- [x] `cargo test -p nucleus-native-harness effigy`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if raw doctor output must become durable task history.
