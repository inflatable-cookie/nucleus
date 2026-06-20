# 509 Git Dry Run Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../109-git-scm-capture-dry-run-adapter-proof.md`

## Purpose

Define non-mutating Git command descriptors for SCM capture dry-run proof.

## Scope

- Describe `git status` and diff-summary style dry-run commands.
- Keep descriptors data-only.
- Exclude commit, push, branch mutation, PR, merge, and raw output retention.

## Acceptance Criteria

- [x] Descriptors identify non-mutating Git commands.
- [x] Descriptors include bounded output expectations.
- [x] Descriptors grant no commit, push, or forge authority.
- [x] Raw output retention remains blocked.

## Validation

- `cargo test -p nucleus-server git_dry_run_command_descriptors -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
