# 299 Task Work Progress Query From State

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../066-task-backed-workflow-hardening.md`

## Purpose

Route task work progress and task-agent diagnostics through persisted
task-history source records instead of empty proof fixtures.

## Scope

- Read task-agent source records from server-owned task history.
- Build task work progress query records from the persisted source set.
- Build task-agent diagnostics from the persisted source set.
- Keep control DTOs read-only.

## Acceptance Criteria

- [x] `RuntimeMetadataQuery::ListTaskWorkProgress` returns persisted work-unit
      progress records.
- [x] `DiagnosticsQuery::TaskAgent` returns persisted work-unit diagnostics.
- [x] Client mutation authority remains false.
- [x] Provider execution authority remains false.

## Validation

- `cargo test -p nucleus-server task_work_progress_query -- --nocapture`
- `cargo test -p nucleus-server diagnostics_queries -- --nocapture`

## Stop Conditions

- Stop if the query path needs task mutation authority or provider execution
  authority to expose persisted records.
