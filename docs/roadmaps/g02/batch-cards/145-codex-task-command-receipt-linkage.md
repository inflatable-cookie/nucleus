# 145 Codex Task Command Receipt Linkage

Status: planned
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

- Receipts can identify command/tool causes.
- Evidence is sanitized and reference-only.
- Output payloads are not copied into DTOs.

## Validation

- `cargo test -p nucleus-server runtime_receipt`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if linkage requires raw stdout/stderr or provider payloads.
