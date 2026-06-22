# 326 Provider Status Check Refresh Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Prove stopped status/check refresh blockers and no-effect behavior.

## Acceptance Criteria

- [x] Tests cover ready, blocked, and repair-required records.
- [x] Duplicate/no-op records are deferred to the persistence slice.
- [x] Tests assert no credential resolution, provider network calls, provider
  effects, callbacks, interruption/recovery execution, task mutation, or raw
  payload retention.
- [x] Tests stay focused on the stopped read family, not persistence or live
  provider behavior.
