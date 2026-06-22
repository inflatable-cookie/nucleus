# 245 Provider Pull-Request Refresh Record Builder

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../066-stopped-provider-pull-request-refresh-control.md`

## Purpose

Build stopped provider pull-request/merge-request refresh records from provider
context refs and repository metadata refs.

## Acceptance Criteria

- [x] Ready records use `PullRequestRefresh` as the provider operation family.
- [x] Missing required refs produce repair-required records.
- [x] Empty scoped change-request refs produce repair-required records.
- [x] Prohibited live provider work produces blocked records.
