# 559 Accepted Memory Persistence Receipts

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../127-accepted-memory-authority-proof.md`

## Purpose

Persist admitted accepted-memory records and emit sanitized receipts.

## Work

- [x] Write accepted-memory records through the SharedMemory state domain.
- [x] Enforce stable ids and revision expectations.
- [x] Emit sanitized runtime receipts with proposal, admission, operator,
  reviewer, source, sensitivity, retention, and revision refs.
- [x] Keep proposal mutation, projection files, embeddings, search, provider
  sync, task mutation, SCM/forge mutation, and UI out of scope.

## Acceptance Criteria

- [x] Admitted accepted memory persists and can be read back.
- [x] Blocked admissions do not mutate shared memory.
- [x] Receipts contain refs only, not raw memory bodies or private payloads.

## Result

Added server-side accepted-memory persistence through the `SharedMemory` state
domain.

The persistence proof:

- stores admitted accepted-memory records as shared-memory records
- creates records with `MustNotExist` revision expectations
- uses stable accepted-memory ids as record ids
- emits sanitized persistence receipts with refs, counts, sensitivity,
  retention, and revision metadata
- leaves blocked admissions as no-mutation receipts

No proposal mutation, projection file write, embedding, search index,
provider-native sync, automatic extraction, task mutation, SCM/forge mutation,
or UI effect was added.
