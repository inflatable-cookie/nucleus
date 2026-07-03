# 535 Memory Proposal Review Diagnostics Query CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../122-memory-proposal-review-command-foundation.md`

## Purpose

Expose read-only diagnostics for memory proposal review command outcomes.

## Work

- [x] Add a server query/control DTO for review diagnostics.
- [x] Add `nucleusd query` rendering.
- [x] Add an Effigy selector.
- [x] Add focused tests.

## Acceptance Criteria

- [x] Diagnostics report reviewed, queued, deferred, rejected, and blocked
  counts.
- [x] Diagnostics do not expose raw payloads, private notes, secrets, provider
  payloads, or source bodies.
- [x] Diagnostics do not mutate memory proposals.
