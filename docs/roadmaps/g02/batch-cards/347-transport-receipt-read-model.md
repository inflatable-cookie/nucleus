# 347 Transport Receipt Read Model

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../076-codex-provider-session-and-stdio-persistence.md`

## Purpose

Expose session/frame/decode persistence through read-only transport receipt
read models.

## Scope

- Summarize session state, frame counts, decode status, receipt refs, and
  repair needs.
- Route through existing diagnostics/read-model patterns.
- Keep client authority false.

## Acceptance Criteria

- [x] Transport receipts expose persisted evidence refs.
- [x] Diagnostics are sanitized and read-only.
- [x] Repair-required states remain visible.
- [x] No raw provider material is exposed.

## Validation

- `cargo test -p nucleus-server transport_receipt_read_model -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
