# 514 Nucleus Memory Crate Front Door

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Add a focused `nucleus-memory` crate for memory proposal records.

## Work

- [x] Add the crate to the workspace.
- [x] Create a small `lib.rs` module index.
- [x] Add named modules for ids, proposals, refs, review, and storage shape.
- [x] Keep behavior out of broad server modules.

## Acceptance Criteria

- [x] The crate builds.
- [x] `lib.rs` remains a front door, not a catch-all.
- [x] No memory extraction, embeddings, accepted-memory mutation, provider sync,
  or UI behavior is added.

## Evidence

- `Cargo.toml`
- `crates/nucleus-memory/Cargo.toml`
- `crates/nucleus-memory/src/lib.rs`
- `crates/nucleus-memory/src/ids.rs`
- `crates/nucleus-memory/src/proposals.rs`
- `crates/nucleus-memory/src/refs.rs`
- `crates/nucleus-memory/src/review.rs`
- `crates/nucleus-memory/src/storage_shape.rs`
