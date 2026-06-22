# 363 Provider Live Read Stopped Smoke Request

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../090-provider-live-read-smoke-approval-gate.md`

## Purpose

Represent a stopped live-read smoke request that cannot execute by default.

## Acceptance Criteria

- [x] Request records reference smoke target, authority checklist, and stopped
  handoff evidence.
- [x] Missing approval keeps the request blocked.
- [x] Blockers cover credential, network, payload, retention, approval, and
  sanitization refs.
- [x] Request records do not call providers or retain raw payloads.
