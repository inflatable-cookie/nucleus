# 023 Git Commit Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../005-git-commit-admission.md`

## Purpose

Describe commit commands from admitted records without executable argv or shell
handoff.

## Acceptance Criteria

- [x] Descriptors reference commit admission ids.
- [x] Commit message source remains inspectable.
- [x] Blocked admissions do not produce ready descriptors.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server git_commit_command_descriptors -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
