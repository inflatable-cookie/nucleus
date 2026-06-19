# 305 Codex Live Executor Outcome Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../068-codex-live-executor-integration.md`

## Purpose

Add typed records for live Codex executor attempts and outcomes.

## Scope

- Define accepted, completed, failed, timed-out, blocked, and cleanup-required
  outcome states.
- Include provider instance id, write attempt id, thread id, turn id, status,
  evidence refs, and receipt refs.
- Include method sequence, cleanup status, notification count, and server
  request count.
- Exclude raw prompt, response text, raw frames, stdout, stderr, and stream
  deltas.
- Add unit tests for valid and forbidden records.

## Acceptance Criteria

- [x] Outcome records compile in focused modules.
- [x] Tests reject raw material fields.
- [x] Records preserve identity needed for replay and diagnostics.
- [x] Records do not imply task completion, review acceptance, callback
      authority, cancellation, or resume authority.

## Validation

- targeted server tests
- `cargo check --workspace`
