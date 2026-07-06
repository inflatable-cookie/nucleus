# 135 Accepted Memory Review Receipt Persistence And Apply Admission

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Make accepted-memory import-apply review decisions durable, then add a stopped
active-apply admission gate over approved review receipts.

Roadmap `134` proved sanitized approve, defer, reject, and blocked review
receipts as pure models and read-only diagnostics. Those diagnostics are still
synthetic. Before any active accepted-memory mutation executor exists, Nucleus
needs durable review receipts and an explicit admission model that can prove an
apply request is backed by an approved review decision.

This lane does not mutate accepted-memory records. It does not write projection
files, share through SCM/forge, run embeddings/search, sync provider-native
memory, extract memories automatically, mutate tasks, schedule agents, or
implement final UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/132-accepted-memory-import-apply-admission.md`
- `docs/roadmaps/g03/133-accepted-memory-review-product-consumption-readiness.md`
- `docs/roadmaps/g03/134-accepted-memory-import-apply-review-commands.md`

## Goals

- [x] Define durable accepted-memory import-apply review receipt storage.
- [x] Persist sanitized review receipts without raw memory bodies.
- [x] Expose review receipt persistence diagnostics through server query,
  control DTO, `nucleusd`, and Effigy.
- [x] Define stopped active-apply admission records that require approved
  durable review receipts.
- [x] Keep accepted-memory mutation, projection writes, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, and final UI behavior out of scope.

## Execution Plan

- [x] Batch 1: define durable review receipt persistence boundary and storage
  shape.
- [x] Batch 2: implement review receipt persistence, codec, and state-backed
  query diagnostics.
- [x] Batch 3: define stopped active-apply admission over persisted approved
  review receipts.
- [x] Batch 4: expose active-apply admission diagnostics through read-only
  control surfaces.
- [x] Batch 5: validate and choose whether the next lane is a minimal active
  apply executor, SCM share, search/provider-sync planning, automatic
  extraction planning, final UI planning, or rebaseline.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/595-accepted-memory-apply-admission-validation-next-lane.md`
- `batch-cards/594-accepted-memory-active-apply-admission-diagnostics.md`
- `batch-cards/593-accepted-memory-active-apply-admission-boundary.md`
- `batch-cards/592-accepted-memory-review-receipt-storage-query.md`
- `batch-cards/591-accepted-memory-review-receipt-persistence-boundary.md`

## Boundary

Durable review receipt records may store:

- stable review receipt id
- project id
- command id
- operator ref
- approval ref for approve decisions
- decision reason ref for defer and reject decisions
- apply admission, import admission, conflict, candidate, memory, and file refs
- sanitized provenance and evidence refs
- decision and status
- blocker summaries
- timestamps/revision refs if already supported by local storage shape

Stopped active-apply admission records may prove that a requested active apply
has a durable approved review receipt and exact candidate/import/apply refs.

## Stop Conditions

- The work requires creating, updating, deleting, or superseding accepted-memory
  records.
- The work requires writing projection files.
- The work requires SCM/forge capture, publication, push, PR, merge, or status
  effects.
- The work requires embeddings, search, provider-native memory sync, automatic
  extraction, task mutation, agent scheduling, callback, interruption, recovery,
  raw payload retention, or final UI behavior.

## Acceptance Criteria

- [x] Review receipts are durable, sanitized, and distinct from active apply
  receipts.
- [x] Approved review receipts are queryable without exposing raw memory
  bodies.
- [x] Stopped active-apply admissions require durable approved review receipts.
- [x] Deferred, rejected, blocked, duplicate, missing-ref, and effect-widened
  states cannot grant active apply admission.
- [x] No accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Validation Result

Review receipt persistence and stopped active-apply admission validated through
focused server, control DTO, CLI, selector, package check, docs QA, Northstar
QA, format check, diff check, and Effigy doctor runs. Doctor remains
warning-only for known god-file findings.

The next lane is
`docs/roadmaps/g03/136-accepted-memory-active-apply-executor-boundary.md`.
It may add a minimal server-local accepted-memory apply executor, but only
behind durable approved review receipts and admitted active-apply authority.
Projection writes, SCM/forge mutation, embeddings/search/provider sync,
automatic extraction, task mutation, agent scheduling, callbacks,
interruption/recovery, raw payload retention, and final UI behavior remain
separate lanes.
