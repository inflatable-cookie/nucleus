# 532 Memory Proposal Review Command Boundary

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../122-memory-proposal-review-command-foundation.md`

## Purpose

Select the first memory proposal review command boundary.

## Work

- [x] Inspect current memory proposal storage, query, and desktop proof
  surfaces.
- [x] Choose the first review actions: queue, defer, reject, and mark reviewed
  for promotion unless evidence says otherwise.
- [x] Define no-effect rules for accepted memory, projection, embeddings,
  provider-native memory sync, and automatic extraction.
- [x] Capture the decision before implementation.

## Acceptance Criteria

- [x] The command boundary is explicit.
- [x] Commands target proposal review/status metadata only.
- [x] Accepted memory creation, projection, embeddings, semantic search,
  provider-native memory sync, automatic extraction, and UI controls are
  deferred.
