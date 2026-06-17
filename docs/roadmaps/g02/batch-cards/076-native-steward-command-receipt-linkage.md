# 076 Native Steward Command Receipt Linkage

Status: completed
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

- [x] Completed steward command outcomes can cite runtime receipts.
- [x] Evidence refs are sanitized.
- [x] Command outcomes do not duplicate receipt payloads.

## Outcome

- Added native steward command receipt-link records.
- Added outcome helpers for attaching receipt and evidence refs without
  copying payloads.
- Validated raw payload terms are rejected from command receipt links.

## Validation

- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo test -p nucleus-engine runtime_receipt`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if raw command output must be copied into command records.
