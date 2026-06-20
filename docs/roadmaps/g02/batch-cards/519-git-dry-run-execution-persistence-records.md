# 519 Git Dry Run Execution Persistence Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../111-git-dry-run-command-execution-persistence.md`

## Purpose

Persist sanitized Git dry-run execution records from request, runner-boundary,
and evidence capture records.

## Scope

- Store execution id, request id, handoff id, capture id, repo id, descriptor
  id, status, summary counts, and evidence refs.
- Reject raw stdout, stderr, diff, and provider material.
- Keep records append-like and deterministic.

## Acceptance Criteria

- [x] Persisted records round-trip sanitized fields.
- [x] Raw output cannot be stored.
- [x] Git mutation authority remains false.
- [x] Evidence refs survive reopen.

## Validation

- `cargo test -p nucleus-server git_dry_run_execution_persistence_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
