# 293 Codex Transport Execution Persistence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../065-codex-turn-start-transport-executor-handoff.md`

## Purpose

Persist Codex transport execution attempts as sanitized receipts and
event-store refs.

## Scope

- Persist accepted, blocked, failed, and skipped execution attempts.
- Link attempts to runtime receipts.
- Link attempts to runtime observation events where appropriate.
- Keep replay from re-running provider writes.

## Acceptance Criteria

- [x] Persistence records are replay-safe.
- [x] Blocked execution attempts remain inspectable.
- [x] Raw payloads and full streams are not stored.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if persistence needs a stronger event-store sequence rule first.
