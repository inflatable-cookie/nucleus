# 330 Provider Status Check Refresh Persistence Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Expose read-only diagnostics/control counts for persisted status/check refresh
records.

## Acceptance Criteria

- [x] Diagnostics report ready, blocked, repair, duplicate/no-op, blocker, and
  evidence counts.
- [x] Control DTOs remain sanitized and read-only.
- [x] No provider refresh or credential resolution action is exposed.
