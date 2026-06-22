# 333 Provider Read Intent Status Check Projection

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Fold persisted status/check refresh records into the generic provider
read-intent projection.

## Acceptance Criteria

- [x] Projection family vocabulary includes status/check refresh.
- [x] Projection counts include status/check refresh records.
- [x] Existing credential, repository metadata, and pull-request families keep
  their current behavior.
- [x] No provider effects are added.
