# 128 Accepted Memory Read-Only Inspection

Status: completed
Owner: Tom
Updated: 2026-07-05

## Purpose

Expose accepted memory as a read-only server inspection surface after the
accepted-memory authority proof.

This lane should let the server list and summarize accepted-memory records
from the shared-memory state domain. It must not add memory projection files,
embeddings, semantic search, provider-native memory sync, automatic
extraction, final UI, task mutation, or SCM/forge mutation.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g03/127-accepted-memory-authority-proof.md`

## Goals

- [x] Add a sanitized accepted-memory read model over accepted-memory storage
  records.
- [x] Add a read-only server query that decodes accepted-memory records from
  the `SharedMemory` state domain.
- [x] Add DTO/CLI/Effigy inspection only after the server query shape is
  stable enough.
- [x] Keep projection, embeddings, search, provider sync, automatic
  extraction, task mutation, SCM/forge mutation, and final UI out of scope.

## Execution Plan

- [x] Batch 1: accepted-memory read projection model.
- [x] Batch 2: read-only server query over shared-memory accepted records.
- [x] Batch 3: serialized DTO and root inspection surface.
- [x] Batch 4: validation and next-lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/563-accepted-memory-dto-cli-effigy-inspection.md`
- `batch-cards/562-accepted-memory-query-control.md`
- `batch-cards/561-accepted-memory-read-projection.md`

## Validation Result

Accepted-memory read inspection validated through focused memory/server/CLI
tests, package checks, docs QA, Northstar QA, diff check, and Effigy doctor.
Doctor is warning-only for pre-existing god-file pressure.

The selected next lane is
`docs/roadmaps/g03/129-accepted-memory-projection-policy-gate.md`.
Projection policy is the next useful boundary because the server can now
inspect accepted memory, but still lacks an explicit eligibility gate before
any accepted memory becomes repo-backed shared project context.

## Projection Result

Accepted memory now has a pure server read projection. It exposes ids, refs,
bucket counts, source/link/evidence counts, skipped record counts, and
no-effect flags without raw memory bodies or private payloads.

The next step is a read-only query over the `SharedMemory` state domain that
classifies persisted records into accepted, proposal-skipped, unsupported, or
decode-failed projection inputs.

## Query Result

Accepted memory now has a read-only server query over the `SharedMemory` state
domain. The query decodes accepted-memory records, skips proposal records,
reports unsupported records and decode failures as sanitized counts, and
returns the accepted-memory projection without mutation.

Serialized DTO, CLI, and Effigy inspection are now complete. The remaining
slice is validation and next-lane selection from the read-only evidence.

## Inspection Result

Accepted memory now has serialized control-envelope request/response DTOs,
`nucleusd query accepted-memory --project <project-id>`, and the root Effigy
selector `server:query:accepted-memory`.

The inspection path reports sanitized memory ids, refs, source/link/evidence
counts, status/scope/kind/sensitivity/retention/confidence buckets, skipped
records, and no-effect flags. It does not expose raw memory bodies, mutate
state, write projection files, run embeddings/search, or sync provider-native
memory.

## Stop Conditions

- The lane requires embeddings, vector search, semantic ranking, provider
  memory sync, or automatic memory extraction.
- The lane requires projection files or project-repo mutation.
- The lane requires final UI behavior instead of server inspection.
- The lane requires raw transcripts, provider payloads, terminal streams,
  credentials, secret values, or private notes.

## Acceptance Criteria

- [x] Accepted memory can be listed from server-owned state without exposing
  raw bodies in receipts or diagnostics.
- [x] Read models expose ids, scope/kind/status buckets, refs, confidence,
  sensitivity, retention, and counts.
- [x] Non-accepted shared-memory records are ignored or reported as skipped
  without decode failures becoming raw payload exposure.
- [x] The next lane is selected from evidence after read-only inspection.
