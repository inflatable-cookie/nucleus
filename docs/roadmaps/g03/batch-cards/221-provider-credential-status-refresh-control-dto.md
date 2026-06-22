# 221 Provider Credential Status Refresh Control Dto

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../061-stopped-provider-credential-status-refresh-control.md`

## Purpose

Expose read-only control counts for stopped provider credential-status refresh
records.

## Acceptance Criteria

- [x] Control DTO counts refresh, ready, repair-required, blocked, ready
  credential, repair credential, unknown credential, unsupported credential,
  blocker, and skipped credential refs.
- [x] Control DTOs expose no credential resolution, provider call, provider
  effect, callback, interruption, recovery, task mutation, or raw payload
  authority.
- [x] Control DTOs serialize without secret material.
