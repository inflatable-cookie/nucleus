# 274 Codex Recovery Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Expose Codex recovery outcomes through read-only diagnostics.

## Scope

- Add client-safe diagnostics DTOs with next action hints.
- Show resume, repair, replacement-thread, and task-mutation gaps explicitly.
- Do not add desktop panels.
- Do not expose raw provider payloads.

## Acceptance Criteria

- [x] Clients can inspect recovery status without command authority.
- [x] Diagnostics serialize without raw provider data.
- [x] Task-mutation gaps remain explicit.

## Closeout

Added read-only Codex recovery diagnostics from sanitized recovery outcome
records. The DTO exposes need, admission, envelope, provider-thread,
replacement-thread, receipt, evidence, status, next-action, and task-mutation
state without granting resume, repair, or task mutation authority.

Diagnostics now distinguish resume accepted, blocked, repair required,
replacement-thread observed, failed, and unsupported recovery outcomes.
Serialization tests assert that raw provider payloads, provider-send state, and
recovery authority input do not leak into client diagnostics.

## Validation

- [x] `cargo test -p nucleus-server recovery -- --nocapture`
- [x] `cargo test -p nucleus-server codex_recovery -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.
