# 516 Memory Review Sensitivity Retention Records

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Add review, sensitivity, and retention value records for memory proposals.

## Work

- [x] Add review state values.
- [x] Add sensitivity classes.
- [x] Add retention posture values.
- [x] Add supersession refs.
- [x] Add tests for restricted/user-private/secret-adjacent boundaries.

## Acceptance Criteria

- [x] User-private and restricted memory are represented explicitly.
- [x] Secret-adjacent memory can reference sanitized context without storing
  secret values.
- [x] Accepted-memory mutation remains deferred.

## Evidence

- `crates/nucleus-memory/src/review.rs`
- `crates/nucleus-memory/src/proposals.rs`
- `crates/nucleus-memory/src/lib.rs`
- `cargo test -p nucleus-memory`
