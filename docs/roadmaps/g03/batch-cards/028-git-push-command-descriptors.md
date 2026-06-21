# 028 Git Push Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../006-git-push-admission.md`

## Purpose

Describe push commands from admitted records without executable argv or shell
handoff.

## Acceptance Criteria

- [x] Descriptors reference push admission ids.
- [x] Remote target remains inspectable.
- [x] Blocked admissions do not produce ready descriptors.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server provider_git_push_command_descriptors::tests::git_push_command_descriptors_preserve_remote_target -- --nocapture --test-threads=1`
- [x] `cargo test -p nucleus-server provider_git_push_command_descriptors::tests::git_push_command_descriptors_block_failed_admissions -- --nocapture --test-threads=1`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`

Note: the broader filtered test command was interrupted after the test binary
sat idle before printing the test list. Exact descriptor tests passed.
