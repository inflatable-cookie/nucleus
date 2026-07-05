# 573 Accepted Memory Projection Write Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../130-accepted-memory-projection-file-materialization.md`

## Purpose

Expose accepted-memory projection write diagnostics through the same read-only
operator surfaces as the readiness gate.

## Work

- [x] Add a server query for accepted-memory projection write diagnostics.
- [x] Add control-envelope request/response DTOs.
- [x] Add `nucleusd query accepted-memory-projection-writes --project
  <project-id>`.
- [x] Add an Effigy selector for the same query.
- [x] Render materialized files, skipped refs, blocker reasons, and no-effect
  flags without raw memory bodies.

## Acceptance Criteria

- [x] DTO tests cover request/response round trips.
- [x] CLI rendering tests prove sanitized output.
- [x] Effigy selector resolves without package scripts.
- [x] Diagnostics distinguish file writes from SCM/forge, import/apply,
  embedding/search, provider-sync, task, and UI effects.

## Result

Accepted-memory projection write diagnostics are now exposed through server
query, control DTO, `nucleusd query accepted-memory-projection-writes
--project <project-id>`, and `effigy
server:query:accepted-memory-projection-writes`.

The diagnostics report accepted/skipped records, admitted and blocked writes,
payload readiness, materialized file count, blockers, file refs, and explicit
no-effect flags without raw memory bodies.
