# 485 SCM Capture Dry Run State API

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../104-scm-capture-dry-run-planning-persistence.md`

## Purpose

Read persisted SCM capture dry-run planning records in deterministic order.

## Scope

- Add read API over artifact metadata.
- Filter by dry-run persistence prefix.
- Preserve stable ordering across reopen.

## Acceptance Criteria

- [x] Persisted dry-run planning records round trip.
- [x] Reads sort deterministically.
- [x] Non-dry-run records are ignored.
- [x] No external effect executes while reading.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_state_api -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
