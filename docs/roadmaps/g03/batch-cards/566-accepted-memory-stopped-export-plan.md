# 566 Accepted Memory Stopped Export Plan

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Produce deterministic stopped export-plan refs for projectable accepted
memories without writing projection files.

## Work

- [ ] Define stopped export-plan records for accepted-memory projection.
- [ ] Use deterministic path refs under `nucleus/memory/<memory-id>.toml`.
- [ ] Preserve blockers for path safety, unsupported schema, unsupported
  memory kind, and policy denial.
- [ ] Keep materialized file writes and SCM mutation out of scope.

## Acceptance Criteria

- [ ] Eligible records produce stable export-plan refs.
- [ ] Blocked records produce sanitized blocker diagnostics.
- [ ] Tests prove no projection file write or SCM effect is represented as
  completed.
