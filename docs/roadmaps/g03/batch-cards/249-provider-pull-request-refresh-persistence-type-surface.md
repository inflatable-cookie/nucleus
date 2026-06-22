# 249 Provider Pull-Request Refresh Persistence Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../067-stopped-provider-pull-request-refresh-persistence.md`

## Purpose

Define stopped provider PR/MR refresh persistence input, record, set, status,
blocker, diagnostics, and control DTO types.

## Acceptance Criteria

- [x] Types preserve provider context, provider instance, forge provider,
  remote repo, refresh scope, credential-status evidence,
  repository-metadata evidence, pull-request-refresh evidence, sanitization
  policy, and evidence refs.
- [x] Types represent persisted, duplicate no-op, and blocked persistence
  states.
- [x] Types expose explicit no-effect flags.
