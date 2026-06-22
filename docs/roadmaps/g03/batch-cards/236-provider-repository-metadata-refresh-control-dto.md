# 236 Provider Repository Metadata Refresh Control Dto

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../064-stopped-provider-repository-metadata-refresh-control.md`

## Purpose

Expose read-only control counts for stopped provider repository metadata
refresh records.

## Acceptance Criteria

- [x] Control DTO counts refresh, ready, repair-required, blocked, blocker, and
  skipped provider context refs.
- [x] Control DTOs expose no credential resolution, provider call, provider
  effect, callback, interruption, recovery, task mutation, or raw payload
  authority.
- [x] Control DTOs serialize without secret material.
