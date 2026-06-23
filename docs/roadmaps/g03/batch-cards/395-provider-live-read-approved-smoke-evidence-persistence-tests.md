# 395 Provider Live Read Approved Smoke Evidence Persistence Tests

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../099-provider-live-read-approved-smoke-evidence-persistence.md`

## Purpose

Cover the approved smoke evidence persistence branch with focused tests.

## Acceptance Criteria

- [x] Round-trip test proves persisted selected fields read back cleanly.
- [x] Duplicate noop test proves repeat records can be represented.
- [x] Blocker test proves effectful or unpromoted records are not persisted.
- [x] Sanitization assertions reject credential and raw payload markers.
