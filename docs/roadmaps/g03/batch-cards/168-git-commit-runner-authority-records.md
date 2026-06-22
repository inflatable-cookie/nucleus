# 168 Git Commit Runner Authority Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../051-git-commit-runner-proof.md`

## Purpose

Add explicit commit runner authority records from existing Git commit preflight
records.

## Acceptance Criteria

- [x] Ready preflight records can become commit-runner authority records only
  with explicit operator commit intent.
- [x] Commit message material is represented as a sanitized ref.
- [x] Push, PR, forge, provider, callback, interruption, recovery, task
  mutation, and raw-output authority remain blocked.
- [x] Non-ready preflights and missing message refs are repair/blocked records,
  not runner permission.

## Validation

- `cargo test -p nucleus-server git_commit_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
