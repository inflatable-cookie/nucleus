# 252 Provider Pull-Request Refresh Persistence Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../067-stopped-provider-pull-request-refresh-persistence.md`

## Purpose

Prove stopped provider PR/MR refresh persistence blocks missing evidence and
prohibited effects.

## Acceptance Criteria

- [x] Round-trip persistence keeps sanitized records intact.
- [x] Duplicate refresh ids become no-op records.
- [x] Missing evidence refs block persistence.
- [x] Credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation block persistence.
- [x] Diagnostics summarize persisted records without raw provider output.
