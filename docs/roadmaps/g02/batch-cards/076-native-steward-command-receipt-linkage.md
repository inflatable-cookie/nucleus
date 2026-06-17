# 076 Native Steward Command Receipt Linkage

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../019-native-steward-command-boundary.md`

## Purpose

Tie accepted steward commands to runtime receipts and sanitized evidence.

## Scope

- Add receipt refs to steward command outcomes.
- Add evidence-source refs for Effigy, SCM, projection, task, docs, and
  validation evidence.
- Keep raw output and model payloads out of command records.

## Acceptance Criteria

- Completed steward command outcomes can cite runtime receipts.
- Evidence refs are sanitized.
- Command outcomes do not duplicate receipt payloads.

## Validation

- `cargo test -p nucleus-native-harness steward`
- `cargo test -p nucleus-engine runtime_receipt`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if raw command output must be copied into command records.
