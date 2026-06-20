# 386 Durable Live Provider Write Evidence Capture

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../084-durable-codex-live-provider-write-invocation.md`

## Purpose

Capture sanitized evidence from the durable live provider-write smoke.

## Scope

- Capture provider instance, write attempt, thread, turn, method sequence,
  notification count, request count, final status, cleanup status, and evidence
  refs.
- Persist through existing live outcome and durable smoke evidence paths.
- Reject raw payloads, raw streams, secrets, credentials, and task mutation.

## Acceptance Criteria

- [x] Successful smoke evidence persists as sanitized records.
- [x] Failed, timed-out, blocked, and cleanup-required outcomes remain
      inspectable.
- [x] Raw material is rejected at retention boundaries.
- [x] Duplicate write attempt handling is deterministic.

## Result

Added durable live provider-write evidence capture over the existing durable
smoke evidence and live executor outcome persistence paths.

## Validation

- `cargo test -p nucleus-server durable_live_provider_write_evidence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
