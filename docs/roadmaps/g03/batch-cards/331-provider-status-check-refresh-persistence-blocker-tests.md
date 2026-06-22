# 331 Provider Status Check Refresh Persistence Blocker Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Prove persisted status/check refresh records keep stopped no-effect behavior.

## Acceptance Criteria

- [x] Tests cover ready persistence, duplicate/no-op persistence, blocked
  persistence, and repair-required persistence.
- [x] Tests assert no raw payload, provider network, credential material, or
  task mutation fields leak into storage/control DTOs.
