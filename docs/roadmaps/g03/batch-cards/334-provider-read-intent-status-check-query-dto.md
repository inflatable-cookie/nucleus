# 334 Provider Read Intent Status Check Query DTO

Status: ready
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Expose status/check read-intent projection data through query/control DTOs.

## Acceptance Criteria

- [ ] In-process query reads persisted status/check records.
- [ ] Serialized DTOs include sanitized family/source counts.
- [ ] `nucleusd`, Effigy, Tauri IPC, and desktop drilldown paths remain
  read-only.
