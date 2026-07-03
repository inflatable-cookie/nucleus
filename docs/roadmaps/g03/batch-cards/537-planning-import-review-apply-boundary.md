# 537 Planning Import Review Apply Boundary

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../123-planning-projection-import-review-apply.md`

## Purpose

Select the first planning projection import review/apply boundary.

## Work

- [x] Inspect existing import candidate, admission, conflict staging, and
  diagnostics surfaces.
- [x] Define which reviewed import records can enter apply planning.
- [x] Define blocked states for conflicts, missing refs, stale revisions,
  unsafe refs, unsupported schema, unsupported kind, and parse failure.
- [x] Define no-effect rules for active planning mutation, task creation, task
  promotion, projection writes, SCM/forge mutation, provider execution, agent
  scheduling, semantic merge automation, accepted memory mutation, and UI.
- [x] Capture the boundary decision before implementation.

## Acceptance Criteria

- [x] The review/apply boundary is explicit.
- [x] Apply planning is distinct from active planning mutation.
- [x] Conflict and merge policy gaps stay visible instead of being resolved by
  default.
- [x] Deferred effects are named before any Rust behavior is added.

## Decision

First boundary:

- reviewed stopped import admissions may enter apply-readiness evaluation
- apply-readiness is a pure model and does not mutate planning records
- dry-run apply plans may be created only after readiness is explicit
- active planning mutation remains deferred to a later explicit admission lane

Ready inputs:

- import scan candidate exists
- stopped import admission exists
- candidate has a stable projected record id
- candidate/admission refs are sanitized and project-scoped
- candidate was reviewed before admission
- no staged semantic conflict is linked to the candidate/admission

Blocked inputs:

- unsupported schema
- unsupported projection record kind
- unsafe path
- parse failure
- duplicate projection id
- missing source refs
- missing projected record id
- unreviewed candidate
- blocked candidate
- duplicate no-op admission
- staged semantic conflict
- stale or missing expected target revision
- missing local target when update semantics require one
- unsupported target domain

No-effect rules:

- active planning records are not mutated
- task records are not created
- task seeds are not promoted
- projection files are not written
- SCM/forge state is not mutated
- providers are not executed
- agents are not scheduled
- semantic conflicts are not auto-merged
- accepted memory is not mutated
- UI behavior is not added
