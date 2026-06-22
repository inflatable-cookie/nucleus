# 328 Provider Status Check Refresh Persistence Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Define persistence records for stopped status/check refresh evidence.

## Acceptance Criteria

- [x] Persistence types store sanitized refs and counters only.
- [x] Record identity supports duplicate/no-op detection.
- [x] No credential material or raw provider payload storage is introduced.
