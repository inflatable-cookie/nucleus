# 257 Provider Read-Intent Projection Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../069-provider-read-intent-projection-control.md`

## Purpose

Define generic stopped provider read-intent projection input, entry, set,
family, status, and control DTO types.

## Acceptance Criteria

- [x] Types accept persisted credential-status, repository-metadata, and PR/MR
  refresh records.
- [x] Entries expose family, provider context, provider instance, forge
  provider, remote repo, operation family, status, blockers, evidence counts,
  and no-effect flags.
- [x] Control DTO exposes aggregate sanitized counts.
