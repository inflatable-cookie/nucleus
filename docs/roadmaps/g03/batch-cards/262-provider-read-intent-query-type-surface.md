# 262 Provider Read-Intent Query Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../070-provider-read-intent-query-composition.md`

## Purpose

Define read-only provider read-intent query result, source counts, and control
DTO types.

## Acceptance Criteria

- [x] Types expose projection, source counts, and no-effect flags.
- [x] Control DTO wraps projection control counts and source counts.
- [x] Types do not expose credential material or raw provider payloads.
