# 224 Provider Credential Status Refresh Persistence Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../062-stopped-provider-credential-status-refresh-persistence.md`

## Purpose

Define stopped provider credential-status refresh persistence input, record,
set, status, blocker, diagnostics, and control DTO types.

## Acceptance Criteria

- [x] Types preserve credential ref, credential kind, resolution boundary,
  current status, status class, allowed operation families, provider context,
  status evidence, sanitization policy, and evidence refs.
- [x] Types represent persisted, duplicate no-op, and blocked persistence
  states.
- [x] Types expose explicit no-effect flags.
