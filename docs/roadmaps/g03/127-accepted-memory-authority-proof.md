# 127 Accepted Memory Authority Proof

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Add the first bounded accepted-memory authority path after memory proposals and
planning import apply have proved enough server-owned review machinery.

This lane should promote reviewed memory proposals into accepted memory records
only. It must not add embeddings, semantic search, provider-native memory sync,
projection files, autonomous extraction, final UI, or raw transcript storage.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g03/119-planning-memory-proposal-foundation.md`
- `docs/roadmaps/g03/122-memory-proposal-review-command-foundation.md`
- `docs/roadmaps/g03/126-minimum-planning-import-apply-proof.md`

## Goals

- [x] Define the smallest accepted-memory authority boundary.
- [x] Add accepted-memory storage shape without changing proposal records.
- [x] Promote only explicitly reviewed proposals into accepted memory records.
- [x] Persist sanitized accepted-memory records through the server state
  boundary.
- [x] Keep projection, embeddings, semantic search, provider-native sync,
  automatic extraction, raw transcript retention, provider payload retention,
  task mutation, SCM/forge mutation, and UI behavior out of scope.

## Execution Plan

- [x] Batch 1: select accepted-memory boundary and blocked effects.
- [x] Batch 2: add accepted-memory record/storage types in `nucleus-memory`.
- [x] Batch 3: add proposal-to-accepted-memory admission model.
- [x] Batch 4: persist accepted-memory records with revision expectations and
  sanitized receipts.
- [x] Batch 5: validate and choose between read-only inspection, projection
  policy, memory search, or product review controls.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/560-accepted-memory-validation-next-lane.md`
- `batch-cards/559-accepted-memory-persistence-receipts.md`
- `batch-cards/558-memory-proposal-acceptance-admission.md`
- `batch-cards/557-accepted-memory-storage-shape.md`
- `batch-cards/556-accepted-memory-authority-boundary.md`

## Boundary Decision

Proceed with accepted-memory storage shape only.

Promotable proposals must be `review_requested` with
`reviewed_for_promotion`, reviewer/operator refs, and sanitized source or
evidence refs. Accepted memory uses new stable memory ids and keeps the source
proposal id as evidence, not identity.

The first accepted-memory storage statuses are `accepted`, `stale`,
`superseded`, and `archived`. Projection, embeddings, semantic search,
provider-native sync, autonomous extraction, task mutation, SCM/forge mutation,
raw transcript retention, provider payload retention, credential/secret
storage, and UI behavior remain blocked.

## Storage Result

`nucleus-memory` now has separate accepted-memory domain and storage types.
Proposal ids remain evidence refs and proposal records are unchanged.

Accepted-memory storage round-trips as sanitized JSON with stable ids, source
proposal refs, scope, kind, status, body, source refs, link refs, confidence,
sensitivity, retention, actor refs, review refs, supersession refs, and
timestamps.

## Admission Result

`nucleus-memory` now has a pure proposal-to-accepted-memory admission model.
It admits only `review_requested` proposals with `reviewed_for_promotion`,
operator/reviewer refs, and sanitized evidence refs. It prepares an
`AcceptedMemoryStorageRecord` but does not write shared memory.

User-private, restricted, secret-adjacent, deferred, rejected, stale,
superseded, and archived proposals are blocked in this lane.

## Persistence Result

Accepted-memory admissions now have a server-side persistence proof through the
`SharedMemory` state domain.

Persisted records use the accepted-memory id as the stable record id, write
with a create-only revision expectation, and emit sanitized receipts with
proposal/admission/operator/reviewer/source/sensitivity/retention/revision
metadata. Blocked admissions return no-mutation receipts.

Proposal mutation, projection files, embeddings, search, provider-native sync,
automatic extraction, raw transcript retention, provider payload retention,
task mutation, SCM/forge mutation, and UI behavior remain blocked.

## Stop Conditions

- The lane requires embeddings, vector search, semantic ranking, or provider
  memory sync.
- The lane requires automatic memory extraction from raw transcripts.
- The lane requires raw provider payloads, terminal output, credentials, secret
  values, or private notes in accepted memory.
- The lane requires repository projection or SCM/forge mutation.
- The lane requires final UI behavior before the server storage path is proven.

## Acceptance Criteria

- [x] Accepted memory has stable ids, scope, kind, status, body, source refs,
  confidence, sensitivity, retention, actor/review refs, and supersession refs.
- [x] Only reviewed proposals can become accepted memory in this lane.
- [x] User-private, restricted, and secret-adjacent policy remains explicit and
  fail-closed.
- [x] Proposal records remain proposal-side evidence rather than authoritative
  memory.
- [x] The lane produces a clear next decision after persistence proof.

## Closeout

Accepted-memory authority proof is complete through boundary selection,
storage shape, proposal-to-accepted-memory admission, persistence receipts, and
validation.

Next lane: read-only accepted-memory inspection. Projection files, embeddings,
semantic search, provider-native sync, automatic extraction, final UI,
SCM/forge mutation, and task mutation remain blocked.
