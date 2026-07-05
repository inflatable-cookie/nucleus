# 554 Minimum Planning Import Apply Proof Implementation

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../126-minimum-planning-import-apply-proof.md`

## Purpose

Implement or reject the smallest safe planning import apply proof.

The proof is limited to the scope selected in card `553`: one reviewed import
file updates one existing active planning artifact through an exact revision
match and a sanitized mutation receipt.

## Work

- [x] Implement only the scoped mutation path from card `553`, or document why
  it should not proceed.
- [x] Preserve revision expectations and sanitized evidence refs.
- [x] Emit a narrow mutation receipt if implementation proceeds.
- [x] Keep unrelated effects blocked.
- [x] Stop instead of implementing if the proof requires a generic merge engine
  or another broad infrastructure layer.

## Acceptance Criteria

- [x] The proof either works under strict constraints or is rejected with a
  concrete reason.
- [x] No broad generic merge engine is added.
- [x] No task/provider/SCM/forge/accepted-memory/UI authority is added.

## Stop/Go Criteria

Proceed only if the code can reuse existing active-apply admission and stopped
executor-plan state, target one existing planning artifact, require an exact
revision match, and emit sanitized evidence.

Stop if implementation needs create/delete/rename support, multi-record apply,
semantic merge, task seed promotion, provider execution, SCM/forge mutation,
accepted memory mutation, raw projected payload retention, or UI workflow
state.

## Result

Implemented `apply_minimum_planning_projection_import_proof` as a narrow server
state helper.

The proof:

- requires a planned-stopped active-apply executor plan
- requires one `apply_planning_artifact` operation
- checks admission, stopped apply, dry-run apply, operator, approval,
  operation, revision, sanitization, file, and target refs
- writes exactly one existing `PlanningArtifact` record through
  `RevisionExpectation::Exact`
- emits one runtime receipt with sanitized refs
- blocks stale revisions, missing targets, unsupported payloads, executor
  blockers, widened authority, raw payload retention, and unrelated effects

Focused tests cover successful apply, stale-revision blocking, and widened
executor-authority blocking.
