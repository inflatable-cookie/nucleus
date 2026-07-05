# 133 Accepted Memory Review Product Consumption Readiness

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Compose the accepted-memory read-side surfaces into a product-consumable review
readiness lane before any active memory apply behavior.

Roadmaps `127` through `132` created accepted-memory authority records,
read-only inspection, projection policy, projection file materialization,
projected-file import validation, and stopped import apply/admission. The next
useful step is not active mutation. It is a read-only view that can tell a
client, steward, or operator what exists, what is projected, what is ready for
review, what is blocked, what is duplicated, and what still needs approval.

This lane does not implement final UI. It creates the server/product boundary
that a future UI can render.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/128-accepted-memory-read-only-inspection.md`
- `docs/roadmaps/g03/129-accepted-memory-projection-policy-gate.md`
- `docs/roadmaps/g03/130-accepted-memory-projection-file-materialization.md`
- `docs/roadmaps/g03/131-accepted-memory-projection-import-validation.md`
- `docs/roadmaps/g03/132-accepted-memory-import-apply-admission.md`

## Goals

- [x] Define the read-only review/product-consumption boundary.
- [x] Shape a server read model that composes existing memory review surfaces
  without creating a parallel authority model.
- [x] Expose diagnostics that answer what is ready, blocked, duplicated,
  projected, importable, or waiting for operator approval.
- [x] Keep active accepted-memory mutation, projection writes, SCM/forge
  mutation, embeddings/search/provider sync, automatic extraction, task
  mutation, and final UI behavior out of scope.

## Execution Plan

- [x] Batch 1: define the review/product-consumption boundary, product
  questions, no-effect rules, and source surfaces.
- [x] Batch 2: model a read-only readiness projection over existing accepted
  memory, proposal review, projection, import validation, and stopped
  apply/admission surfaces.
- [x] Batch 3: expose read-only diagnostics through server query/control,
  `nucleusd`, and Effigy if the model shape holds.
- [x] Batch 4: validate and choose the next bounded lane.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/586-accepted-memory-review-product-consumption-validation.md`
- `batch-cards/585-accepted-memory-review-control-diagnostics.md`
- `batch-cards/584-accepted-memory-review-read-model-shape.md`
- `batch-cards/583-accepted-memory-review-consumption-boundary.md`

## Boundary

The product-consumption surface is read-only and server-owned. It may combine
sanitized counts, ids, refs, status buckets, blocker classes, duplicate no-op
classes, approval requirements, and evidence refs from existing accepted-memory
surfaces.

It must not:

- expose raw memory bodies, transcripts, provider payloads, terminal streams,
  credentials, secrets, or private notes
- create, update, delete, or supersede accepted-memory records
- write or rewrite projection files
- run SCM or forge capture/share/publication
- run embeddings, vector index writes, semantic search, or provider-native
  memory sync
- run automatic memory extraction
- mutate tasks or schedule agents
- commit to final UI layout, desktop controls, or review interaction design

## Product Questions

The first read model should answer:

- which accepted memories exist for a project
- which memories are eligible for projection
- which projection writes are admitted, skipped, or blocked
- which projected memory files validate as import candidates
- which imports are duplicates, conflicts, blocked, or ready for apply review
- which stopped apply/admission records have operator approval refs
- which records need repair, review, or explicit approval before any later
  active apply lane

## Stop Conditions

- The work requires active accepted-memory mutation.
- The work requires writing projection files.
- The work requires SCM/forge capture, publication, push, PR, merge, or status
  effects.
- The work requires embeddings, search, provider-native memory sync, automatic
  extraction, task mutation, agent scheduling, callback, interruption, recovery,
  raw payload retention, or final UI behavior.

## Acceptance Criteria

- [x] The lane documents a clear product-consumption boundary over existing
  accepted-memory surfaces.
- [x] The read model avoids a new authority source and preserves source refs.
- [x] Diagnostics can distinguish ready, blocked, duplicated, conflict,
  approval-required, projected, and importable states.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Validation Result

Accepted-memory review/product-consumption readiness is complete through
boundary docs, a derived server read model, control-envelope DTOs, `nucleusd`,
Effigy selector, focused tests, package checks, docs QA, Northstar QA, and
diff check.

The next lane is
`docs/roadmaps/g03/134-accepted-memory-import-apply-review-commands.md`.
It should add explicit review command receipts for approving, deferring, or
rejecting stopped import-apply admissions before any active accepted-memory
mutation executor exists.
