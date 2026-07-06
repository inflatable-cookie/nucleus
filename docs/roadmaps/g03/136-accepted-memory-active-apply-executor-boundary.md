# 136 Accepted Memory Active Apply Executor Boundary

Status: superseded
Owner: Tom
Updated: 2026-07-06

## Superseded By

`docs/roadmaps/g04/001-product-workflow-rebaseline-and-vertical-slice.md`

## Reason

This lane is valid future work, but it is not the right active path now.
Accepted-memory proposal, review, acceptance, projection, import, review
receipt, and active-apply admission surfaces are already deep enough for the
current product phase. Continuing into active accepted-memory mutation before
the project/task/agent workflow feels coherent would over-optimize one
subsystem.

The return point is tracked in `docs/roadmaps/deferred-lanes.md`.

## Purpose

Add the first minimal accepted-memory mutation lane, restricted to server-local
accepted-memory records and gated by durable approved review receipts.

Roadmap `135` made review receipts durable and exposed stopped active-apply
admission diagnostics. This lane may build the smallest executor that converts
an admitted active-apply record into an accepted-memory local-store mutation
and an auditable apply receipt.

This lane does not write projection files, publish through SCM/forge, run
embeddings/search, sync provider-native memory, extract memories automatically,
mutate tasks, schedule agents, execute callbacks/interruption/recovery, retain
raw payloads, or implement final UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/132-accepted-memory-import-apply-admission.md`
- `docs/roadmaps/g03/134-accepted-memory-import-apply-review-commands.md`
- `docs/roadmaps/g03/135-accepted-memory-review-receipt-persistence-and-apply-admission.md`

## Goals

- [ ] Define the minimal active apply executor boundary.
- [ ] Require durable approved review receipt and admitted active-apply record
  before mutation.
- [ ] Mutate only server-local accepted-memory records.
- [ ] Persist sanitized apply receipts and duplicate no-op receipts.
- [ ] Expose read-only diagnostics through server query, control DTO,
  `nucleusd`, and Effigy.
- [ ] Keep projection writes, SCM/forge mutation, embeddings/search/provider
  sync, automatic extraction, task mutation, agent scheduling,
  callback/interruption/recovery, raw payload retention, and final UI behavior
  out of scope.

## Execution Plan

- [ ] Batch 1: define executor boundary, input authority, stop conditions,
  mutation scope, and no-effect flags.
- [ ] Batch 2: implement server-local accepted-memory upsert/delete/no-op
  mutation planning without projection or external effects.
- [ ] Batch 3: persist active apply receipts and idempotency/duplicate no-op
  outcomes.
- [ ] Batch 4: expose active apply executor diagnostics through read-only
  control surfaces.
- [ ] Batch 5: validate and choose whether to continue to projection share,
  SCM share, search/provider-sync planning, automatic extraction planning,
  final memory UI planning, or rebaseline.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Superseded cards:

- `batch-cards/596-accepted-memory-active-apply-executor-boundary.md`
- `batch-cards/597-accepted-memory-active-apply-storage-mutation.md`
- `batch-cards/598-accepted-memory-active-apply-receipts-idempotency.md`
- `batch-cards/599-accepted-memory-active-apply-diagnostics-control.md`
- `batch-cards/600-accepted-memory-active-apply-validation-next-lane.md`

Completed cards:

None.

## Boundary

The executor may:

- read durable review receipts
- read active-apply admission records
- validate exact project, memory, candidate, import, apply, conflict, file,
  provenance, and evidence refs
- create or update the server-local accepted-memory record for the admitted
  memory
- record duplicate no-op when the target accepted-memory record already
  matches
- persist a sanitized active-apply receipt with ids, refs, status, blocker
  summaries, and no-effect flags

The executor must not:

- write `nucleus/memory/*.toml`
- call Git, another SCM, a forge, or provider network
- run embeddings, semantic search, vector indexing, or provider-native memory
  sync
- extract memories automatically from conversations
- mutate tasks, schedule agents, or trigger callbacks/interruption/recovery
- retain raw memory bodies outside the accepted-memory storage shape
- implement final UI behavior

## Stop Conditions

- The work requires projection file writes or SCM/forge sharing.
- The work requires embeddings, search, provider-native memory sync, or
  automatic extraction.
- The work requires task mutation, agent scheduling, callback, interruption,
  recovery, raw transcript/provider payload retention, credential access, or
  final UI behavior.
- The work cannot prove idempotent duplicate no-op behavior before mutation.

## Acceptance Criteria

- [ ] Active apply requires durable approved review receipt and admitted
  active-apply authority.
- [ ] Only server-local accepted-memory records are mutated.
- [ ] Duplicate no-op, blocked, stale, missing-ref, and effect-widened states
  do not mutate accepted memory.
- [ ] Apply receipts are persisted and sanitized.
- [ ] Diagnostics expose counts and refs without raw transcripts, provider
  payloads, terminal streams, credentials, or private notes.
