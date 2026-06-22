# 174 Git Push Runner Command Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../052-git-push-runner-proof.md`

## Purpose

Build constrained Git push command argv from push-runner authority records.

## Acceptance Criteria

- [x] Ready authority records produce `git push <remote> HEAD:<branch>` argv.
- [x] Shell passthrough is never used.
- [x] Repo working-directory refs and remote targets are required.
- [x] The adapter does not execute the command or push refs.

## Validation

- `cargo test -p nucleus-server git_push_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
