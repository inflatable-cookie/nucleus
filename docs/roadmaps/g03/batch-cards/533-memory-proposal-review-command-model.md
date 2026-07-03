# 533 Memory Proposal Review Command Model

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../122-memory-proposal-review-command-foundation.md`

## Purpose

Add the pure command model and validation for memory proposal review actions.

## Work

- [x] Add action vocabulary for queue, defer, reject, and reviewed for
  promotion.
- [x] Validate proposal id, expected revision, reviewer ref, optional note, and
  allowed state transitions.
- [x] Keep the model pure and side-effect-free.

## Acceptance Criteria

- [x] Invalid inputs are rejected with explicit reasons.
- [x] Review state does not create accepted memory.
- [x] Focused tests cover allowed and blocked transitions.
