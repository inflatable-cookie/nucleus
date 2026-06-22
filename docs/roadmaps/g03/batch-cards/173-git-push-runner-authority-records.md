# 173 Git Push Runner Authority Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../052-git-push-runner-proof.md`

## Purpose

Add explicit push runner authority records from existing Git push preflight
records.

## Acceptance Criteria

- [x] Ready preflight records can become push-runner authority records only
  with explicit operator push intent.
- [x] Remote target refs are required.
- [x] PR, forge, provider, callback, interruption, recovery, task mutation, and
  raw-output authority remain blocked.
- [x] Non-ready preflights and missing remote targets are repair/blocked
  records, not runner permission.

## Validation

- `cargo test -p nucleus-server git_push_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
