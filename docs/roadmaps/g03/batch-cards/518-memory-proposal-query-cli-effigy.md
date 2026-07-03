# 518 Memory Proposal Query CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Expose read-only memory proposal inspection if storage is ready.

## Work

- [x] Add a server query shape for memory proposals or diagnostics.
- [x] Add control DTO support.
- [x] Add `nucleusd query` rendering.
- [x] Add an Effigy selector.
- [x] Add focused tests.

## Acceptance Criteria

- [x] Query reports sanitized counts, scopes, statuses, sensitivity buckets,
  retention buckets, and refs.
- [x] Raw transcript, provider payload, secret material, private memory bodies,
  and terminal streams are not exposed.
- [x] No accepted-memory mutation, provider, task, SCM, forge, embedding, deep
  research, or UI effects are added.

## Evidence

- `crates/nucleus-server/src/memory_proposals_projection.rs`
- `crates/nucleus-server/src/request_handler/queries/memory_proposals.rs`
- `crates/nucleus-server/src/control_envelope_dto/response/records/memory_proposals.rs`
- `apps/nucleusd/src/query/typed_response/memory_proposals.rs`
- `effigy.toml`
- `cargo test -p nucleus-server memory_proposals -- --nocapture`
- `cargo test -p nucleusd memory_proposals -- --nocapture`
- `effigy server:query:memory-proposals`
