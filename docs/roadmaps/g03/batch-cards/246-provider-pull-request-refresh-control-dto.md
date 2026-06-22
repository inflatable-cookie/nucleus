# 246 Provider Pull-Request Refresh Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../066-stopped-provider-pull-request-refresh-control.md`

## Purpose

Expose read-only control DTO counts for stopped provider pull-request or
merge-request refresh records.

## Acceptance Criteria

- [x] DTOs count ready, repair-required, blocked, skipped, and blocker totals.
- [x] DTOs expose no-effect flags.
- [x] DTO serialization excludes credential material and raw provider payloads.
