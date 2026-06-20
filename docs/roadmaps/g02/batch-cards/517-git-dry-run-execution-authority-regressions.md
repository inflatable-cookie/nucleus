# 517 Git Dry Run Execution Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../110-git-dry-run-command-execution-boundary.md`

## Purpose

Prove the Git dry-run execution boundary cannot mutate SCM, forge, provider,
callback, interruption, recovery, or raw-output state.

## Scope

- Exercise request, runner-boundary, and evidence capture records together.
- Assert all external effect authorities remain false.
- Keep dry-run evidence replayable by refs.

## Acceptance Criteria

- [x] Commit, checkout, branch mutation, push, PR, and merge remain blocked.
- [x] Provider, callback, interruption, and recovery effects remain blocked.
- [x] Raw output retention remains blocked.
- [x] Dry-run command evidence remains replayable by refs.

## Validation

- `cargo test -p nucleus-server git_dry_run_execution_authority_regressions -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
