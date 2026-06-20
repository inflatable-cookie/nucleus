# 431 Live Evidence Task State History Response

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../093-live-evidence-task-state-control-integration.md`

## Purpose

Expose task-history projection responses for admitted live evidence task-state
transitions.

## Scope

- Project admitted transitions into task-history response records.
- Preserve skipped transition refs.
- Keep responses sanitized.

## Acceptance Criteria

- [x] History response includes completed task-state entries.
- [x] Blocked transitions are skipped.
- [x] Response contains refs, not raw provider material.
- [x] Response grants no mutation/provider/SCM authority.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_history_response -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
