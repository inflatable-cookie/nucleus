# 248 Codex Live Spawn Smoke Evidence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../056-codex-live-spawn-smoke-gate.md`

## Purpose

Capture smoke startup evidence and cleanup outcomes safely.

## Scope

- Persist sanitized startup summaries and refs.
- Record stdout/stderr byte counts and truncation flags, not raw streams.
- Map cleanup results to receipts.

## Acceptance Criteria

- Evidence excludes credentials and raw provider payloads.
- Cleanup-required state is visible.
- Receipts remain replay-safe.

## Result

Implemented sanitized smoke evidence and runtime receipt mapping with command
evidence refs, output byte counts, truncation flags, cleanup-required state,
and no raw stream retention.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if evidence capture needs raw stream retention.
