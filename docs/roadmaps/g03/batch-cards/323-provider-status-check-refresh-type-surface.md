# 323 Provider Status Check Refresh Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Define the stopped status/check refresh type surface.

## Acceptance Criteria

- [x] Types model provider context refs, provider instance refs, remote repo
  refs, target change refs, status/check evidence refs, and sanitization refs.
- [x] Status/check refresh is classified as a read family.
- [x] Type names do not imply live provider refresh or status/check writes.
- [x] No credential material or raw provider payload fields are added.
