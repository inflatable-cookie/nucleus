# 329 Provider Status Check Refresh Persistence Store

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Persist stopped status/check refresh records in local store.

## Acceptance Criteria

- [x] Store helpers write and read sanitized status/check refresh records.
- [x] Revision behavior follows existing provider read-family persistence.
- [x] Duplicate/no-op records do not rewrite unrelated provider evidence.
