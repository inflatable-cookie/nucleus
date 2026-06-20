# 392 Durable Live Provider Write Terminal Outcomes

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../085-durable-codex-live-provider-write-execution.md`

## Purpose

Make failed, blocked, timed-out, and cleanup-required durable live provider
write outcomes inspectable.

## Scope

- Map live runner failures into sanitized terminal outcome evidence.
- Persist blocked and cleanup-required records without raw stderr/stdout or
  provider payloads.
- Ensure duplicate write attempts do not create duplicate durable effects.
- Keep repair-required evidence explicit.

## Acceptance Criteria

- [x] Failed outcomes persist sanitized failure status.
- [x] Timed-out and cleanup-required outcomes persist repair state.
- [x] Blocked outcomes persist without invoking provider I/O.
- [x] Duplicate write attempts are no-op records.

## Result

Failed, timed-out, blocked, cleanup-required, and duplicate durable live
provider-write outcomes now have inspectable sanitized evidence paths.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_terminal_outcomes -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
