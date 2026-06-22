# 239 Provider Repository Metadata Refresh Persistence Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../065-stopped-provider-repository-metadata-refresh-persistence.md`

## Purpose

Define stopped provider repository metadata refresh persistence input, record,
set, status, blocker, diagnostics, and control DTO types.

## Acceptance Criteria

- [x] Types preserve provider context, provider instance, forge provider,
  remote repo, operation family, credential-status evidence,
  repository-metadata evidence, sanitization policy, and evidence refs.
- [x] Types represent persisted, duplicate no-op, and blocked persistence
  states.
- [x] Types expose explicit no-effect flags.
