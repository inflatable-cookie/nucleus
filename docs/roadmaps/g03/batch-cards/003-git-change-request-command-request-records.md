# 003 Git Change Request Command Request Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../001-git-change-request-execution-gate.md`

## Purpose

Convert eligible Git command descriptors into stopped-by-default command
request records.

## Scope

- Preserve descriptor and authority refs.
- Add idempotency ids.
- Keep execution disabled unless later admitted by preflight.

## Acceptance Criteria

- [x] Request records reference descriptors.
- [x] Idempotency ids are deterministic.
- [x] Blocked descriptors do not create executable requests.
- [x] No command runs.

## Validation

- [x] `cargo test -p nucleus-server git_change_request_command_request_records -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
