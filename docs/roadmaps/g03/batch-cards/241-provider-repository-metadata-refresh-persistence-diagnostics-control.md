# 241 Provider Repository Metadata Refresh Persistence Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../065-stopped-provider-repository-metadata-refresh-persistence.md`

## Purpose

Expose read-only diagnostics and control counts for persisted stopped provider
repository metadata refresh records.

## Acceptance Criteria

- [x] Diagnostics count persisted, duplicate, blocked, ready, repair-required,
  and unsupported records.
- [x] Diagnostics expose missing-evidence and blocked-effect counts.
- [x] Control DTOs serialize sanitized counts only.
