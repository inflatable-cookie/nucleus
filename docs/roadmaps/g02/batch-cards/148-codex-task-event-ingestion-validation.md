# 148 Codex Task Event Ingestion Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../033-codex-task-event-ingestion-and-receipts.md`

## Purpose

Validate Codex task event ingestion and receipt linkage.

## Scope

- Run focused Codex, receipt, task-agent, and docs gates.
- Confirm replay determinism.
- Advance to checkpoint and review loop.

## Acceptance Criteria

- Event ingestion cards are complete or rehomed.
- Work-unit progress is rebuildable.
- Next ready card points to checkpoint/review work.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo test -p nucleus-server runtime_receipt`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if progress projection is not deterministic.
