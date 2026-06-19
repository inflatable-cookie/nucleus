# 298 Task Agent Source Record Persistence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../066-task-backed-workflow-hardening.md`

## Purpose

Persist task-agent work-unit source records as durable task-history facts.

## Scope

- Add a server state domain path for task history.
- Add SQLite storage support for task-history records.
- Add a sanitized task-agent work-unit source-record codec.
- Preserve revision expectations for source-record writes.
- Reject summaries that try to retain raw provider material.

## Acceptance Criteria

- [x] Source records survive backend reopen.
- [x] Source records sort by source cursor when read back.
- [x] Duplicate writes respect revision expectations.
- [x] Raw provider material is rejected before persistence.
- [x] No client or provider execution authority is introduced.

## Validation

- `cargo test -p nucleus-server task_agent_work_unit_state -- --nocapture`
- `cargo test -p nucleus-local-store sqlite_first_slice_domain_records_survive_reopen -- --nocapture`

## Stop Conditions

- Stop if task history storage requires a broader database migration policy.
