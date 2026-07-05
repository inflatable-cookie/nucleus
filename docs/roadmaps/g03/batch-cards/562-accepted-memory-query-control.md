# 562 Accepted Memory Query Control

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../128-accepted-memory-read-only-inspection.md`

## Purpose

Expose accepted-memory projection through a read-only server query.

## Work

- [x] Add a server query type for accepted memory by project.
- [x] Read from the `SharedMemory` state domain and decode accepted-memory
  records only.
- [x] Report skipped proposal/unsupported records as sanitized diagnostics.
- [x] Keep all mutation and follow-on memory effects out of scope.

## Acceptance Criteria

- [x] Query tests prove accepted-memory records can be read from persisted
  state.
- [x] Proposal records and decode failures do not leak raw payloads.
- [x] The query is read-only and does not mutate shared memory.

## Result

Added a read-only server query for accepted memory by project.

The query reads the `SharedMemory` state domain and classifies records as:

- accepted-memory records
- proposal records skipped
- unsupported records skipped
- decode failures skipped

The result is the sanitized accepted-memory projection. DTO serialization is
explicitly unsupported until the next card. No shared-memory mutation,
projection file write, embedding, search, provider sync, task mutation,
SCM/forge mutation, or UI behavior was added.
