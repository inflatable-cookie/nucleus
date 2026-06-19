# 273 Codex Recovery Envelope Receipts

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Map accepted Codex recovery/resume attempts to sanitized provider envelopes and
receipts.

## Scope

- Define provider resume envelope identity and method.
- Include runtime, session, provider thread/turn, task, and work item refs.
- Map accepted, blocked, failed, replacement-thread, and unsupported outcomes
  to receipts.
- Exclude raw provider payloads.

## Acceptance Criteria

- [x] Envelope records are replay-safe and idempotency-friendly.
- [x] Receipts distinguish resume, repair, replacement-thread, and failed
      states.
- [x] Task mutation is not implied.

## Closeout

Added sanitized Codex recovery envelopes for accepted `thread/resume` intent.
Envelope records include runtime, session, provider thread/turn/request, task,
and work-item refs while keeping provider send, raw payload retention,
replacement-thread permission, and task mutation disabled.

Added recovery outcome and receipt records for accepted resume intent, blocked
admission, repair-required state, replacement-thread observation, failed
recovery, and unsupported recovery. Receipts map resume intent to accepted,
repair and replacement-thread cases to recovery-required, failed cases to
failed, and unsupported/blocked cases to blocked.

## Validation

- [x] `cargo test -p nucleus-server recovery -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if envelope mapping needs refreshed Codex schema evidence.
