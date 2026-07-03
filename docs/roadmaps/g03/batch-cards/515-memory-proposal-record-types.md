# 515 Memory Proposal Record Types

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Model memory proposals as provisional project context records.

## Work

- [x] Add stable memory proposal id types.
- [x] Add proposal scope, kind, status, title, body/summary, confidence, and
  timestamps.
- [x] Add source refs without using source ids as durable memory identity.
- [x] Add tests that proposed memory remains non-authoritative.

## Acceptance Criteria

- [x] Proposed memory is distinct from accepted memory.
- [x] Scope and kind do not grant visibility or projection authority.
- [x] Raw transcripts, provider payloads, terminal streams, and credentials are
  not represented as proposal payload fields.

## Evidence

- `crates/nucleus-memory/src/ids.rs`
- `crates/nucleus-memory/src/proposals.rs`
- `crates/nucleus-memory/src/refs.rs`
- `crates/nucleus-memory/src/review.rs`
- `crates/nucleus-memory/src/lib.rs`
- `cargo test -p nucleus-memory`
