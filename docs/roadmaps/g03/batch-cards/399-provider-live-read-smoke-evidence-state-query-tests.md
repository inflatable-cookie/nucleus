# 399 Provider Live Read Smoke Evidence State Query Tests

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../100-provider-live-read-smoke-evidence-state-backed-query.md`

## Purpose

Cover empty and seeded persisted smoke evidence query states.

## Acceptance Criteria

- [x] Empty state returns zero evidence records.
- [x] Persisted promoted evidence returns promoted diagnostics.
- [x] Serialized response remains sanitized.
