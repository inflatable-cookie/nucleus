# 250 Provider Pull-Request Refresh Persistence Store

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../067-stopped-provider-pull-request-refresh-persistence.md`

## Purpose

Store sanitized stopped provider PR/MR refresh persistence records through local
artifact metadata.

## Acceptance Criteria

- [x] Persisted records are keyed by refresh id.
- [x] Duplicate refresh ids produce deterministic no-op records.
- [x] Readback returns sanitized records only.
- [x] Storage does not retain credential material, provider payloads, or raw
  provider payloads.
