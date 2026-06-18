# 143 Codex Task Runtime Admission Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../032-codex-task-runtime-admission-bridge.md`

## Purpose

Validate Codex task runtime admission without execution.

## Scope

- Run focused Codex, scheduler, task-agent, and docs gates.
- Confirm no process launch path exists.
- Advance to event ingestion and receipts.

## Acceptance Criteria

- Admission bridge cards are complete or rehomed.
- Runtime requests can be admitted or rejected.
- Next ready card points to event ingestion.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo test -p nucleus-server scheduler`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if admission requires starting Codex.
