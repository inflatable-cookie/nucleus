# 357 Provider Live Read Stopped Executor Handoff

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../089-provider-live-read-execution-contract-and-adapter-boundary.md`

## Purpose

Represent stopped executor handoff records from persisted live-read plans.

## Acceptance Criteria

- [x] Persisted live-read records can produce stopped handoff records.
- [x] Handoffs carry sanitized request refs, capability refs, lease refs, and
  evidence refs.
- [x] Blockers cover missing authority, lease, request, fixture client, and
  sanitization refs.
- [x] Handoffs do not call providers or mutate task state.
