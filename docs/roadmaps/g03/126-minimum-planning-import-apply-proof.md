# 126 Minimum Planning Import Apply Proof

Status: completed
Owner: Tom
Updated: 2026-07-04

## Purpose

Define the smallest useful proof that a reviewed planning import can update one
safe active planning artifact.

The previous lanes built enough guardrails to reason about the risk:
projection import, dry-run apply planning, active-apply admission, diagnostics,
and a stopped executor model. This lane should not add another broad layer
before proving value. It should choose one constrained mutation path and keep
everything else blocked.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/roadmaps/g03/123-planning-projection-import-review-apply.md`
- `docs/roadmaps/g03/124-planning-import-active-apply-admission.md`
- `docs/roadmaps/g03/125-planning-import-active-apply-executor-boundary.md`

## Goals

- [x] Select one safe planning artifact mutation path for proof.
- [x] Require existing admission/executor guardrails before mutation.
- [x] Keep task creation, provider execution, SCM/forge mutation, accepted
  memory mutation, semantic merge automation, and UI behavior out of scope.
- [x] Produce a clear stop/go decision before building more planning-import
  infrastructure.

## Execution Plan

- [x] Batch 1: define the minimum apply proof scope and stop conditions.
- [x] Batch 2: implement or reject the smallest safe mutation path.
- [x] Batch 3: validate the proof and decide whether executor persistence,
  diagnostics, desktop review controls, or a different product lane should be
  next.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/555-minimum-planning-import-apply-proof-validation-next-lane.md`
- `batch-cards/554-minimum-planning-import-apply-proof-implementation.md`
- `batch-cards/553-minimum-planning-import-apply-proof-scope.md`

## Scope Decision

The proof target is one existing active planning artifact record.

The only allowed mutation is an exact-revision replacement of that artifact
from a reviewed planning projection import file. The operation must require
active-apply admission, a stopped executor-plan ref, operator approval, import
file evidence, target artifact evidence, expected and observed revision refs,
an applied operation ref, a sanitization policy ref, and a mutation receipt.

The mutation fails closed when the target is missing, the revision differs, the
import record is not reviewed, or the required refs are absent.

Blocked work remains blocked: create/delete/rename, multi-record apply,
semantic merge, task creation, task seed promotion, provider execution,
SCM/forge mutation, accepted memory mutation, raw projected payload retention,
and UI behavior.

## Implementation Result

The minimum proof is implemented as a server state helper. It applies one
reviewed planning projection import file to one existing planning artifact only
when the active-apply executor plan is planned-stopped, the operation kind is
`apply_planning_artifact`, the current revision matches exactly, and all
sanitized refs are present.

The proof writes one `PlanningArtifact` record in the Planning domain and one
runtime receipt. It does not add generic merge, task promotion, provider,
SCM/forge, accepted-memory, or UI authority.

## Next Lane

Selected: `127-accepted-memory-authority-proof.md`.

Planning import/apply pauses after the minimum proof. The next product value is
durable accepted shared memory from reviewed memory proposals, not deeper
planning-import executor persistence or desktop controls.

## Stop Conditions

- The proof requires broad generic merge logic.
- The proof requires task creation, task promotion, provider execution,
  SCM/forge mutation, accepted memory mutation, semantic merge automation,
  callback, interruption, recovery, or UI behavior.
- The proof requires raw projected payload retention beyond the immediate
  in-memory operation needed to write the active planning artifact.

## Acceptance Criteria

- [x] The first proof is narrow enough to implement and review directly.
- [x] Existing admission/executor guardrails remain meaningful.
- [x] The lane produces evidence about product value, not another abstract
  safety shell by default.
