# 499 SCM Capture Dry Run Execution Persistence Records

Status: ready
Owner: Tom
Updated: 2026-06-20
Milestone: `../107-scm-capture-dry-run-execution-persistence.md`

## Purpose

Persist sanitized SCM capture dry-run execution receipt records.

## Scope

- Persist receipt identity, outcome, counts, labels, and evidence refs.
- Block raw output and non-dry-run external effects.
- Keep capture, publish, and forge mutation out of persistence.

## Acceptance Criteria

- [ ] Dry-run execution receipts produce persistence records.
- [ ] Persisted records contain refs and counts only.
- [ ] Raw output requests are blocked.
- [ ] No capture, publish, or forge authority is granted.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_persistence_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
