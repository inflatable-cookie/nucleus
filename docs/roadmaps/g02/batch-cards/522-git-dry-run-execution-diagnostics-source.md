# 522 Git Dry Run Execution Diagnostics Source

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../111-git-dry-run-command-execution-persistence.md`

## Purpose

Derive read-only diagnostics from persisted Git dry-run execution records.

## Scope

- Summarize persisted, blocked, completed, failed, timed-out, and
  repair-required records.
- Surface evidence refs and descriptor ids.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics derive from persisted records.
- [x] Counts are stable and deterministic.
- [x] Evidence refs remain inspectable.
- [x] Diagnostics grant no SCM, forge, provider, callback, interruption,
  recovery, or raw-output authority.

## Validation

- `cargo test -p nucleus-server git_dry_run_execution_diagnostics_source -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
