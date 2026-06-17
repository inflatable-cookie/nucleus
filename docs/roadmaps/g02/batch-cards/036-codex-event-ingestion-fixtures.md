# 036 Codex Event Ingestion Fixtures

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../011-codex-app-server-runtime-runway.md`

## Purpose

Add static Codex-shaped event ingestion fixtures before live app-server
execution.

## Scope

- Add fixture events for thread start/resume, turn start/complete, item
  lifecycle, content delta, tool call, approval request, user-input request,
  interruption, warning/error, and runtime receipt.
- Map fixture events into canonical runtime/timeline records.
- Keep raw provider payload retention behind sanitized evidence policy.
- Prove rejected or unsupported events fail closed.
- Do not spawn Codex or stream a live session.

## Acceptance Criteria

- Static Codex-shaped events can be normalized into canonical Nucleus records.
- Approval and user-input requests become server-owned wait states.
- Interruption/cancellation produce runtime receipt evidence.
- Unsupported payloads are preserved as diagnostics or rejected explicitly.

## Validation

- `cargo test -p nucleus-agent-protocol`
- `cargo test -p nucleus-engine`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if canonical event payloads are too weak to represent Codex fixtures.
- Stop if fixture mapping starts depending on live provider state.

## Outcome

Implemented static Codex fixture projection in
`crates/nucleus-agent-protocol/src/codex.rs`.

Covered fixtures:

- thread start and resume
- turn start and complete
- item lifecycle
- assistant content delta
- tool-call start
- command/file/provider approval requests
- structured user-input requests
- warning and error diagnostics
- interruption receipt fixtures

Unsupported method/payload combinations fail closed with
`CodexFixtureMappingError`.

Added engine receipt projection in
`crates/nucleus-engine/src/codex_runtime_receipts.rs` so Codex interruption
fixtures become harness-provider runtime receipts instead of timeline
messages.
