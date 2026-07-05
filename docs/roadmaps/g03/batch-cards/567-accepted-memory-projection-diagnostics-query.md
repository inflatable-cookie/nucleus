# 567 Accepted Memory Projection Diagnostics Query

Status: planned
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Expose accepted-memory projection readiness as a read-only server query.

## Work

- [ ] Add a read-only server query over accepted-memory projection policy
  evidence.
- [ ] Report projectable, local-only, blocked, review-required, and skipped
  counts.
- [ ] Include sanitized refs and blocker reasons without raw memory bodies.
- [ ] Keep file writes, import/apply, SCM/forge effects, embeddings, search,
  provider sync, task mutation, and UI out of scope.

## Acceptance Criteria

- [ ] Server query tests cover empty, projectable, blocked, and mixed states.
- [ ] Diagnostics expose no-effect flags.
- [ ] Raw memory bodies and private payloads are not exposed.
