# 422 Provider Live Read Status Check Approved Smoke

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../106-provider-live-read-status-check-smoke.md`

## Purpose

Run exactly one approved `gh pr checks` selected-field provider read.

## Governing Refs

- `../106-provider-live-read-status-check-smoke.md`
- `../103-provider-live-read-second-family-selection.md`

## Acceptance Criteria

- [x] Command uses the selected fields from the status/check stopped request.
- [x] Command is read-only and does not mutate provider, project, or task
  state.
- [x] Raw command output is not committed to the repo.
- [x] Exit code and high-level result category are captured.

## Result

The approved selected-field command completed with exit code `0`.

## Stop Conditions

- Command shape expands beyond selected status/check fields.
- Provider write, task mutation, callback, or recovery execution becomes
  necessary.
