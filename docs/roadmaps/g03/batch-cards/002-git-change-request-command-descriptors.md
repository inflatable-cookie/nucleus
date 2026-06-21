# 002 Git Change Request Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../001-git-change-request-execution-gate.md`

## Purpose

Describe the Git commands that may be needed for a change-request execution
path without constructing executable requests.

## Scope

- Branch/worktree command descriptors.
- Commit command descriptors.
- Push command descriptors.
- Pull-request descriptor placeholder without forge execution.

## Acceptance Criteria

- [x] Descriptors are data-only.
- [x] Descriptors preserve authority refs.
- [x] Unsupported authority states remain visible.
- [x] No shell command or forge request is created.

## Validation

- [x] `cargo test -p nucleus-server git_change_request_command_descriptors -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
