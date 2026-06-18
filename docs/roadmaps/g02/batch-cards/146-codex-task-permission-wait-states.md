# 146 Codex Task Permission Wait States

Status: completed
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

- [x] Permission waits are visible and not terminal by default.
- [x] Human approval remains explicit.
- [x] Timeout/cancellation states are distinct.

## Result

Added wait progress projection from Codex wait links. Waiting is non-terminal;
cancelled and timed-out waits are terminal progress facts.

## Validation

- `cargo test -p nucleus-server codex_wait`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if approval policy is not clear enough to model.
