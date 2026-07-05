# 583 Accepted Memory Review Consumption Boundary

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../133-accepted-memory-review-product-consumption-readiness.md`

## Purpose

Define the read-only accepted-memory review/product-consumption boundary before
building another server read model.

## Work

- [x] Name the source surfaces the boundary may read.
- [x] Define the product questions the readiness view must answer.
- [x] Define the source refs, status classes, blocker classes, and no-effect
  rules.
- [x] Confirm active apply, projection writes, SCM share, search, provider
  sync, automatic extraction, task mutation, and final UI are deferred.

## Acceptance Criteria

- [x] The boundary is read-only and server-owned.
- [x] The boundary composes existing accepted-memory surfaces instead of
  creating a new authority source.
- [x] The boundary can guide a client or steward to the next review/repair
  action without exposing raw memory bodies.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, or
  final UI behavior is added.

## Boundary Result

Allowed source surfaces:

- accepted-memory read-only inspection
- accepted-memory projection policy diagnostics
- accepted-memory projection write diagnostics
- projected accepted-memory import validation diagnostics
- stopped accepted-memory import apply/admission diagnostics

Readiness status classes:

- accepted memory present
- projectable
- projection write admitted
- projection blocked
- import candidate ready
- import candidate blocked
- import admitted
- import blocked
- duplicate no-op
- conflict
- apply admitted
- approval required
- apply blocked

The boundary is derived and read-only. It preserves source refs and blocker
counts. It does not expose raw bodies, apply imports, write files, call SCM or
forge providers, run embeddings/search, sync provider-native memory, extract
new memory, mutate tasks, schedule agents, or define final UI behavior.
