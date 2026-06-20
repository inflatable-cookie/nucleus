# 350 Idempotent Observation Ingestion Cursor

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../077-codex-runtime-observation-event-store-linkage.md`

## Purpose

Track ingestion cursors so duplicate or out-of-order observations fail closed.

## Scope

- Record last accepted sequence per provider session/source.
- Detect duplicate, stale, and gap observations.
- Preserve repair hints for gap states.

## Acceptance Criteria

- [x] Duplicate observations are deterministic no-ops or blocked records.
- [x] Sequence gaps produce repair-required evidence.
- [x] Cursor persistence survives reopen.
- [x] Cursor handling does not invoke provider I/O.

## Validation

- `cargo test -p nucleus-server observation_ingestion_cursor -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
