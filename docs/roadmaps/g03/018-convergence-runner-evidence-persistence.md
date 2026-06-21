# 018 Convergence Runner Evidence Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Persist sanitized Convergence publication runner evidence and expose it through
read-only control DTOs before any stopped runner command adapter is added.

## Governing Refs

- `docs/roadmaps/g03/015-convergence-publication-runner-proof.md`
- `docs/roadmaps/g03/017-server-provider-front-door-consolidation.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist runner evidence with stable ids.
- [x] Preserve proof, request, idempotency, task, repo, and provider-stage refs.
- [x] Expose read-only evidence persistence diagnostics.
- [x] Keep all execution effects false.

## Execution Plan

- [x] Evidence persistence batch.
- [x] Control DTO batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/067-convergence-runner-evidence-persistence.md`
- `batch-cards/068-convergence-runner-evidence-control-dto.md`
- `batch-cards/069-convergence-runner-evidence-persistence-closeout.md`

## Acceptance Criteria

- [x] Reviewable runner evidence can be persisted.
- [x] Blocked evidence remains inspectable.
- [x] Duplicate evidence ids become deterministic no-op records.
- [x] No runner invocation, provider handoff, snapshot creation, publish,
  publication review, provider write, task mutation, callback, interruption,
  recovery, or raw-output effect is added.
