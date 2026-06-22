# 333 Provider Read Intent Status Check Projection

Status: ready
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Fold persisted status/check refresh records into the generic provider
read-intent projection.

## Acceptance Criteria

- [ ] Projection family vocabulary includes status/check refresh.
- [ ] Projection counts include status/check refresh records.
- [ ] Existing credential, repository metadata, and pull-request families keep
  their current behavior.
- [ ] No provider effects are added.
