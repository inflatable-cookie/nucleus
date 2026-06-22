# 358 Provider Live Read Fixture Response Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../089-provider-live-read-execution-contract-and-adapter-boundary.md`

## Purpose

Model sanitized fixture response and error diagnostics for live-read handoffs.

## Acceptance Criteria

- [x] Fixture responses record status, sanitized summary refs, and evidence
  refs.
- [x] Fixture errors record provider family, error class, retry hints, and
  sanitization refs.
- [x] Diagnostics count ready, blocked, error, retryable, and non-retryable
  states.
- [x] Raw request/response bodies and credential material remain absent.
