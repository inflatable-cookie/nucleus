# 005 Git Change Request Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../001-git-change-request-execution-gate.md`

## Purpose

Summarize Git change-request authority, descriptor, request, and preflight
state.

## Scope

- Count ready, blocked, unsupported, and repair-required records.
- Count branch, commit, push, and pull-request gates separately.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics count authority gates.
- [x] Diagnostics count blockers.
- [x] Diagnostics expose no raw command output.
- [x] Diagnostics grant no Git or forge authority.

## Validation

- [x] `cargo test -p nucleus-server git_change_request_diagnostics -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
