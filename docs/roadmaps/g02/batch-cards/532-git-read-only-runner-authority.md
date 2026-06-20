# 532 Git Read Only Runner Authority

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../113-git-read-only-runner-proof.md`

## Purpose

Prove the read-only Git runner cannot mutate SCM, forge, provider, callback,
interruption, recovery, or raw-output state.

## Scope

- Exercise admitted and rejected runner paths.
- Assert mutating verbs are blocked.
- Assert raw output is not persisted.

## Acceptance Criteria

- [x] Checkout, branch, commit, push, PR, and merge remain blocked.
- [x] Provider, callback, interruption, and recovery effects remain blocked.
- [x] Raw output retention remains blocked.
- [x] Sanitized summaries can feed existing persistence records.

## Validation

- `cargo test -p nucleus-server git_read_only_runner_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
