# 581 Accepted Memory Import Apply Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../132-accepted-memory-import-apply-admission.md`

## Purpose

Expose stopped accepted-memory import apply/admission diagnostics through
server query/control, `nucleusd`, and Effigy.

## Work

- [x] Add a read-only server diagnostics query for apply/admission records.
- [x] Add control DTO request/response shapes and tests.
- [x] Add `nucleusd query` rendering and focused CLI tests.
- [x] Add an Effigy selector for the diagnostics query.
- [x] Keep diagnostics free of raw memory bodies, transcripts, provider
  payloads, credentials, and secret values.

## Acceptance Criteria

- [x] Operators can inspect admitted, blocked, duplicate no-op, and no-effect
  outcomes.
- [x] DTO and CLI rendering expose counts, refs, blockers, and no-effect flags.
- [x] The query does not mutate active accepted memory or call SCM/forge,
  provider, search, extraction, task, or UI systems.
