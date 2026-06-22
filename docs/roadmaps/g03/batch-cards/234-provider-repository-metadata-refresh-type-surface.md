# 234 Provider Repository Metadata Refresh Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../064-stopped-provider-repository-metadata-refresh-control.md`

## Purpose

Define stopped provider repository metadata refresh input, record, set, status,
blocker, and control DTO types.

## Acceptance Criteria

- [x] Types consume provider context refs without credential material.
- [x] Types carry provider instance, forge provider, remote repo,
  credential-status evidence, repository-metadata evidence, and sanitization
  policy refs.
- [x] Types represent ready, repair-required, and blocked refresh records.
- [x] Types expose explicit no-effect flags.
