# 347 Provider Live Read Preflight Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../088-provider-live-read-admission-gate.md`

## Purpose

Define preflight records derived from ready live-read admissions.

## Acceptance Criteria

- [x] Preflight input consumes admission records and fixture policy evidence.
- [x] Preflight records name credential-status, network-authority, endpoint,
  payload-retention, idempotency, and sanitization refs.
- [x] Preflight output remains read-only and fixture-backed.
- [x] No provider API call or credential resolution is possible from the type
  surface alone.
