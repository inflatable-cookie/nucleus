# 254 Codex Turn Start Receipts Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../057-codex-turn-start-admission-gate.md`

## Purpose

Expose turn-start outcomes through sanitized receipts and read-only diagnostics.

## Scope

- Map accepted, blocked, failed, and unsupported outcomes to runtime receipts.
- Add diagnostics DTOs with next action hints.
- Do not add desktop panels.
- Do not expose raw prompt or provider payload.

## Acceptance Criteria

- Clients can inspect turn-start status without authority.
- Receipts and diagnostics do not leak raw prompt/provider data.
- Unsupported callback/cancellation states are visible.

## Result

Implemented turn-start outcome records, sanitized runtime receipt mapping, and
read-only diagnostics for accepted, blocked, failed, and unsupported outcomes.
Diagnostics expose next actions without command authority, raw prompt data, or
provider payloads.

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.
