# 226 Provider Credential Status Refresh Persistence Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../062-stopped-provider-credential-status-refresh-persistence.md`

## Purpose

Expose diagnostics and read-only control counts for persisted stopped provider
credential-status refresh records.

## Acceptance Criteria

- [x] Diagnostics count refresh, persisted, duplicate, persistence-blocked,
  ready-refresh, repair-refresh, blocked-refresh, credential status class,
  blocker, and evidence refs.
- [x] Control DTOs carry sanitized counts only.
- [x] Control DTOs expose no credential, provider-call, provider-effect,
  callback, interruption, recovery, task-mutation, or raw payload authority.
