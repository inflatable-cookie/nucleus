# 596 Accepted Memory Active Apply Executor Boundary

Status: superseded
Owner: Tom
Updated: 2026-07-06
Milestone: `../136-accepted-memory-active-apply-executor-boundary.md`

## Purpose

Define the minimal executor boundary for applying accepted-memory imports into
server-local accepted-memory records.

## Superseded Reason

Deferred by `../../g04/001-product-workflow-rebaseline-and-vertical-slice.md`.
The executor boundary remains valid future work, but the active roadmap now
needs a product workflow vertical slice before more accepted-memory mutation
machinery.

## Work

- [ ] Define active-apply executor input, authority refs, and stop conditions.
- [ ] Define apply outcome, receipt, duplicate no-op, blocked, and no-effect
  types.
- [ ] Require durable approved review receipt and admitted active-apply record.
- [ ] Keep projection, SCM/forge, embeddings/search, provider sync,
  extraction, task mutation, agent scheduling, callback/interruption/recovery,
  raw payload retention, and UI behavior out of scope.
- [ ] Add focused tests for admitted, duplicate, blocked, stale, missing-ref,
  and effect-widened cases.

## Acceptance Criteria

- [ ] The executor boundary is explicit and testable.
- [ ] Active apply cannot run from synthetic diagnostics alone.
- [ ] No projection file write, SCM/forge mutation, embeddings/search/provider
  sync, automatic extraction, task mutation, agent scheduling,
  callback/interruption/recovery, raw payload retention, or final UI behavior
  is added.
