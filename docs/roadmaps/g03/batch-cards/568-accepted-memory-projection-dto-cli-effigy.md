# 568 Accepted Memory Projection DTO CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Make accepted-memory projection readiness inspectable from the root task
surface.

## Work

- [x] Add control-envelope request/response DTOs for projection readiness.
- [x] Add `nucleusd query accepted-memory-projection --project <project-id>`.
- [x] Add an Effigy selector for the same query.
- [x] Render counts, blocker reasons, refs, path refs, and no-effect flags
  without raw memory bodies.

## Acceptance Criteria

- [x] DTO tests cover request/response round trips.
- [x] CLI rendering tests prove sanitized output.
- [x] Effigy selector resolves without adding package scripts.

## Result

Accepted-memory projection readiness is now visible through the control
envelope, `nucleusd query accepted-memory-projection --project <project-id>`,
and `effigy server:query:accepted-memory-projection`.

The output reports projection counts, deterministic plan refs, optional file
refs, blocker kinds/details, and no-effect flags. It does not expose raw memory
bodies, provider payloads, terminal streams, projection writes, SCM effects,
import/apply effects, embeddings, or provider sync.
