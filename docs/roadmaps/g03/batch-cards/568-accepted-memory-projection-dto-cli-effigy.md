# 568 Accepted Memory Projection DTO CLI Effigy

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Make accepted-memory projection readiness inspectable from the root task
surface.

## Work

- [ ] Add control-envelope request/response DTOs for projection readiness.
- [ ] Add `nucleusd query accepted-memory-projection --project <project-id>`.
- [ ] Add an Effigy selector for the same query.
- [ ] Render counts, blocker reasons, refs, path refs, and no-effect flags
  without raw memory bodies.

## Acceptance Criteria

- [ ] DTO tests cover request/response round trips.
- [ ] CLI rendering tests prove sanitized output.
- [ ] Effigy selector resolves without adding package scripts.
