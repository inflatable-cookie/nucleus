# 566 Accepted Memory Stopped Export Plan

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Produce deterministic stopped export-plan refs for projectable accepted
memories without writing projection files.

## Work

- [x] Define stopped export-plan records for accepted-memory projection.
- [x] Use deterministic path refs under `nucleus/memory/<memory-id>.toml`.
- [x] Preserve blockers for path safety, unsupported schema, unsupported
  memory kind, and policy denial.
- [x] Keep materialized file writes and SCM mutation out of scope.

## Acceptance Criteria

- [x] Eligible records produce stable export-plan refs.
- [x] Blocked records produce sanitized blocker diagnostics.
- [x] Tests prove no projection file write or SCM effect is represented as
  completed.

## Result

Accepted-memory projection now has stopped export-plan records.

Projectable records produce deterministic plan refs and file refs under
`nucleus/memory/<memory-id>.toml`. Blocked records preserve policy blockers and
export blockers for unsupported schema, unsupported memory kind, unsafe path
refs, and policy denial. No projection file write or SCM effect is represented
as completed.
