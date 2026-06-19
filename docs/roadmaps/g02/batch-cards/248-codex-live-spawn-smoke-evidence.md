# 248 Codex Live Spawn Smoke Evidence

Status: planned
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

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if evidence capture needs raw stream retention.
