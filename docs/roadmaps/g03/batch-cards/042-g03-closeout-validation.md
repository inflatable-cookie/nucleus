# 042 G03 Closeout Validation

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../009-git-change-request-execution-closeout.md`

## Purpose

Validate g03 state and decide whether to close the generation or continue.

## Acceptance Criteria

- [x] G03 roadmap front door is consistent.
- [x] Batch-card index is consistent.
- [x] Validation passes or blockers are recorded.
- [x] Next generation decision is explicit.

## Validation

- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `cargo test -p nucleus-server git_change_request -- --nocapture`
- [x] `cargo test -p nucleus-server git_branch_worktree -- --nocapture`
- [x] `cargo test -p nucleus-server git_commit -- --nocapture`
- [x] `cargo test -p nucleus-server git_push_admission_records -- --nocapture`
- [x] `cargo test -p nucleus-server git_push_preflight_records -- --nocapture`
- [x] `cargo test -p nucleus-server git_push_diagnostics -- --nocapture`
- [x] `cargo test -p nucleus-server forge_pull_request_descriptor_records -- --nocapture`
- [x] `cargo test -p nucleus-server forge_pull_request_dry_run_evidence -- --nocapture`
- [x] `cargo test -p nucleus-server forge_pull_request_execution_admission -- --nocapture`
- [x] `cargo test -p nucleus-server forge_pull_request_execution_preflight -- --nocapture`
- [x] `cargo test -p nucleus-server forge_pull_request_execution_diagnostics -- --nocapture`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Closeout

G03 closes with Git change-request execution represented as stopped-by-default
records through pull-request execution admission. G03 continues with
adapter-neutral change-request chain projection and persistence/control
boundaries, then Convergence-like publication admission.
