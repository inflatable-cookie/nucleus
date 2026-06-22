# 247 Provider Pull-Request Refresh Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../066-stopped-provider-pull-request-refresh-control.md`

## Purpose

Prove stopped provider pull-request/merge-request refresh records block missing
refs and prohibited live provider work.

## Acceptance Criteria

- [x] Ready all-open refresh records are created.
- [x] Specific change-request refresh scopes are accepted.
- [x] Missing refs and empty scoped refs are repair-required.
- [x] Credential material, provider payloads, raw payload retention, real
  credential resolution, provider network calls, callbacks, interruption,
  recovery execution, and task mutation are blocked.
- [x] Control DTOs serialize sanitized counts only.
