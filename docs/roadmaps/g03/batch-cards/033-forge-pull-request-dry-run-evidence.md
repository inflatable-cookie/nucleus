# 033 Forge Pull-Request Dry-Run Evidence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../007-forge-pull-request-descriptor-dry-run.md`

## Purpose

Compose reviewable dry-run evidence for pull-request descriptors.

## Acceptance Criteria

- [x] Evidence records reference descriptor ids.
- [x] Evidence records distinguish reviewable and blocked states.
- [x] Evidence records retain sanitized counts/status only.
- [x] Evidence records do not imply pull-request creation authority.

## Validation

- [x] `cargo test -p nucleus-server forge_pull_request_dry_run_evidence -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
