# 251 Provider Pull-Request Refresh Persistence Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../067-stopped-provider-pull-request-refresh-persistence.md`

## Purpose

Expose read-only diagnostics and control counts for persisted stopped provider
PR/MR refresh records.

## Acceptance Criteria

- [x] Diagnostics count persisted, duplicate, blocked, ready, repair-required,
  and unsupported records.
- [x] Diagnostics expose evidence-ref and blocker counts.
- [x] Control DTOs serialize sanitized counts only.
