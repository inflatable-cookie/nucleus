# 374 Task Backed Live Workflow Fixture

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../082-task-backed-live-workflow-closeout.md`

## Purpose

Build an end-to-end fixture for the task-backed live Codex workflow.

## Scope

- Cover task work item, durable dispatch, invocation, provider observations,
  receipts, timeline, review readiness, and diagnostics.
- Use sanitized fixture data only.
- Keep fixture replay deterministic.

## Acceptance Criteria

- [x] Fixture covers the full task-backed live path.
- [x] Replay rebuilds expected projections.
- [x] Fixture contains no raw provider material.
- [x] Task completion and review acceptance remain separate.

## Result

Added `task_backed_live_workflow_fixture` as a deterministic server replay
fixture covering task work admission, durable scheduler admission, live
executor admission, sanitized outcome linkage, receipt linkage, timeline
projection, explicit review acceptance, and diagnostics.

## Validation

- `cargo test -p nucleus-server task_backed_live_workflow_fixture -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
