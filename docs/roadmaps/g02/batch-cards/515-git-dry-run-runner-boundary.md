# 515 Git Dry Run Runner Boundary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../110-git-dry-run-command-execution-boundary.md`

## Purpose

Define the runner-boundary records for non-mutating Git dry-run command
handoff.

## Scope

- Accept only admitted command request records.
- Model command handoff without shell execution in core tests.
- Carry command argv, cwd ref, timeout, and bounded-output policy.
- Keep raw stdout and stderr out of durable records.

## Acceptance Criteria

- [x] Runner handoff requires admitted dry-run request records.
- [x] Handoff records are explicit about argv and cwd refs.
- [x] Mutating Git verbs remain blocked.
- [x] No shell execution or raw output retention is introduced.

## Validation

- `cargo test -p nucleus-server git_dry_run_runner_boundary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
