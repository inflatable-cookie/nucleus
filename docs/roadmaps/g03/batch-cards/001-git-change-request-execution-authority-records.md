# 001 Git Change Request Execution Authority Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../001-git-change-request-execution-gate.md`

## Purpose

Define Git change-request execution authority records from Git-like adapter
plans.

## Scope

- Preserve Git-like plan refs.
- Split branch, commit, push, and pull-request gates.
- Reject non-ready or non-Git plans.
- Keep all effects false.

## Acceptance Criteria

- [x] Authority records reference Git-like plan ids.
- [x] Branch, commit, push, and pull-request authorities are separate.
- [x] Non-ready Git-like plans are blocked.
- [x] No Git or forge effect is executed.

## Validation

- [x] `cargo test -p nucleus-server git_change_request_execution_authority -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
