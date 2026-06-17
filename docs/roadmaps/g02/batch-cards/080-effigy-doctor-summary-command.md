# 080 Effigy Doctor Summary Command

Status: ready
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

- Doctor summaries are sanitized and reference-backed.
- Repair hints can cite doctor evidence.
- Health status does not imply project mutation.

## Validation

- `cargo test -p nucleus-native-harness effigy`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if raw doctor output must become durable task history.
