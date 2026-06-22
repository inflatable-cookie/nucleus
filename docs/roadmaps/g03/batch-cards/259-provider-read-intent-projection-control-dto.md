# 259 Provider Read-Intent Projection Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../069-provider-read-intent-projection-control.md`

## Purpose

Expose read-only aggregate control counts for stopped provider read-intent
records.

## Acceptance Criteria

- [x] DTO counts total, family, ready, duplicate, blocked, repair-required,
  blocker, and evidence totals.
- [x] DTO exposes no-effect flags.
- [x] DTO serialization excludes credential material and raw provider payloads.
