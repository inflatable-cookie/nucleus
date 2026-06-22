# 225 Provider Credential Status Refresh Persistence Store

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../062-stopped-provider-credential-status-refresh-persistence.md`

## Purpose

Persist sanitized stopped provider credential-status refresh records through
local artifact metadata.

## Acceptance Criteria

- [x] Persisted refresh ids derive deterministically from refresh ids.
- [x] Persisted records round-trip through the local store.
- [x] Duplicate ids become deterministic no-op records.
- [x] Blocked and duplicate records do not write new artifact metadata.
- [x] Reads return records in stable id order.
