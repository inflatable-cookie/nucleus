# 244 Provider Pull-Request Refresh Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../066-stopped-provider-pull-request-refresh-control.md`

## Purpose

Define stopped provider pull-request/merge-request refresh input, scope,
record, set, status, blocker, and control DTO types.

## Acceptance Criteria

- [x] Types preserve provider context, provider instance, forge provider,
  remote repo, refresh scope, credential-status evidence,
  repository-metadata evidence, pull-request-refresh evidence, sanitization
  policy, and evidence refs.
- [x] Types represent all-open and specific change-request refresh scopes.
- [x] Types expose explicit no-effect flags.
