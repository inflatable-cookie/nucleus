# 146 Codex Task Permission Wait States

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../033-codex-task-event-ingestion-and-receipts.md`

## Purpose

Represent permission prompts and human approval waits in task progress.

## Scope

- Project permission waits into work-unit state.
- Keep approval commands separate from wait observation.
- Preserve timeout/cancellation posture.

## Acceptance Criteria

- Permission waits are visible and not terminal by default.
- Human approval remains explicit.
- Timeout/cancellation states are distinct.

## Validation

- `cargo test -p nucleus-server codex_wait`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if approval policy is not clear enough to model.
