# 169 Git Commit Runner Command Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../051-git-commit-runner-proof.md`

## Purpose

Build constrained Git commit command argv from commit-runner authority records.

## Acceptance Criteria

- [x] Ready authority records produce `git commit --file <message-ref>` argv.
- [x] Shell passthrough is never used.
- [x] Repo working-directory refs and commit-message refs are required.
- [x] The adapter does not execute the command or create commits.

## Validation

- `cargo test -p nucleus-server git_commit_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
