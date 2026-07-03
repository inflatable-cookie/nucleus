# 517 Memory Planning Linkage Storage Codec

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Link memory proposals to planning/research/task surfaces and add storage
payloads.

## Work

- [x] Add planning session, exploration session, artifact, task seed, research
  brief, task, and evidence refs.
- [x] Add JSON storage records for memory proposals.
- [x] Add encode/decode tests.
- [x] Keep projection/apply and accepted-memory mutation deferred.

## Acceptance Criteria

- [x] Links are refs only.
- [x] Codec round trips stable ids, scope, kind, status, review, sensitivity,
  retention, and source refs.
- [x] No embeddings, semantic index, provider-native sync, projection apply, or
  UI behavior is added.

## Evidence

- `crates/nucleus-memory/src/refs.rs`
- `crates/nucleus-memory/src/storage_shape.rs`
- `crates/nucleus-memory/src/lib.rs`
- `crates/nucleus-memory/Cargo.toml`
- `cargo test -p nucleus-memory`
