# 394 Provider Live Read Approved Smoke Evidence Persistence Store

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../099-provider-live-read-approved-smoke-evidence-persistence.md`

## Purpose

Persist promoted approved smoke evidence through the server local-store
artifact metadata repository.

## Acceptance Criteria

- [x] Promoted records are written with a stable provider live-read smoke
  evidence persistence prefix.
- [x] Readback filters only that prefix.
- [x] Duplicate inputs can be represented without rewriting the store.
- [x] Blocked or unpromoted records are not written.
