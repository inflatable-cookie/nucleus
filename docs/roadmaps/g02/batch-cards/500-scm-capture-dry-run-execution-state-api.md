# 500 SCM Capture Dry Run Execution State API

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../107-scm-capture-dry-run-execution-persistence.md`

## Purpose

Read persisted SCM capture dry-run execution records in deterministic order.

## Scope

- Add read API over artifact metadata.
- Filter by dry-run execution persistence prefix.
- Preserve stable ordering across reopen.

## Acceptance Criteria

- [x] Persisted execution receipts round trip.
- [x] Reads sort deterministically.
- [x] Non-execution records are ignored.
- [x] No SCM effect executes while reading.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_state_api -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
