# 176 Git Push Runner Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../052-git-push-runner-proof.md`

## Purpose

Expose push runner state through read-only diagnostics/control DTOs.

## Acceptance Criteria

- [x] Diagnostics summarize push runner outcomes and repair states.
- [x] Control DTOs expose counts and refs only.
- [x] Clients receive no PR, forge, provider, callback, recovery, task, or
  raw-output authority from diagnostics.
- [x] Existing warning-sized request/control files are split if touched.

## Validation

- `cargo test -p nucleus-server git_push_runner`
- `cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
