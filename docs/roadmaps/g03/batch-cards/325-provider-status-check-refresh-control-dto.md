# 325 Provider Status Check Refresh Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Expose read-only control counts for stopped status/check refresh records.

## Acceptance Criteria

- [x] DTOs expose counts, statuses, blocker counts, and evidence counts only.
- [x] DTOs expose explicit no-effect flags.
- [x] DTOs contain no provider payload bytes, token-like fields, or raw
  provider request/response bodies.
- [x] Existing provider read families are not changed behaviorally.
