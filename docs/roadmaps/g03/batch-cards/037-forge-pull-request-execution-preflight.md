# 037 Forge Pull-Request Execution Preflight

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../008-forge-pull-request-execution-admission.md`

## Purpose

Model preflight checks for pull-request execution admission records.

## Acceptance Criteria

- [x] Preflight records require forge credential readiness.
- [x] Preflight records require remote branch visibility evidence.
- [x] Blocked admissions do not produce ready preflights.
- [x] No command or forge call runs.

## Validation

- [x] `cargo test -p nucleus-server forge_pull_request_execution_preflight -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
