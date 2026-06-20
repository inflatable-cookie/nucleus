# 444 Live Evidence Task State Control Persistence Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../096-live-evidence-task-state-history-persistence.md`

## Purpose

Define sanitized persistence records for live-evidence task-state control
outputs.

## Scope

- Persist control id, request id, admission refs, history entries, and evidence refs.
- Exclude raw provider material, live handles, and executable SCM instructions.
- Keep task mutation and SCM authority false.

## Acceptance Criteria

- [x] Persistence record carries task/work/completion/history refs.
- [x] Raw provider material is not retained.
- [x] SCM/forge/provider authority remains false.
- [x] Record is serializable.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_control_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
