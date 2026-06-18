# 145 Codex Task Command Receipt Linkage

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../033-codex-task-event-ingestion-and-receipts.md`

## Purpose

Link Codex tool/command observations to runtime receipts.

## Scope

- Attach command/tool refs to work-unit receipts.
- Preserve sanitized evidence refs.
- Keep output payloads behind artifact policies.

## Acceptance Criteria

- [x] Receipts can identify command/tool causes.
- [x] Evidence is sanitized and reference-only.
- [x] Output payloads are not copied into DTOs.

## Result

Added `CodexTaskRuntimeReceiptLink`, mapping typed runtime receipt refs to
client-safe references without copying output payloads.

## Validation

- `cargo test -p nucleus-server runtime_receipt`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if linkage requires raw stdout/stderr or provider payloads.
