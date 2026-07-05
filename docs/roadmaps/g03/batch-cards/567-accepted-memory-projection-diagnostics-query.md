# 567 Accepted Memory Projection Diagnostics Query

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Expose accepted-memory projection readiness as a read-only server query.

## Work

- [x] Add a read-only server query over accepted-memory projection policy
  evidence.
- [x] Report projectable, local-only, blocked, review-required, and skipped
  counts.
- [x] Include sanitized refs and blocker reasons without raw memory bodies.
- [x] Keep file writes, import/apply, SCM/forge effects, embeddings, search,
  provider sync, task mutation, and UI out of scope.

## Acceptance Criteria

- [x] Server query tests cover empty, projectable, blocked, and mixed states.
- [x] Diagnostics expose no-effect flags.
- [x] Raw memory bodies and private payloads are not exposed.

## Result

Accepted-memory projection readiness now has a read-only server query result.

The query reads shared-memory state, decodes accepted-memory records, skips
proposal and decode-failed records, suppresses out-of-scope accepted ids, and
returns sanitized diagnostics for projectable, local-only, blocked, and
review-required records. DTO/CLI/Effigy exposure remains the next card.
