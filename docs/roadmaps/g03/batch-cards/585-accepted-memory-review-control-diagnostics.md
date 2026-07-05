# 585 Accepted Memory Review Control Diagnostics

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../133-accepted-memory-review-product-consumption-readiness.md`

## Purpose

Expose accepted-memory review readiness through read-only control surfaces.

## Work

- [x] Add a server query over the readiness projection.
- [x] Add serialized control-envelope request/response DTOs.
- [x] Add a `nucleusd query` surface.
- [x] Add an Effigy selector if the query is stable.
- [x] Add focused server, DTO, CLI, and selector tests.

## Acceptance Criteria

- [x] Read-only diagnostics expose readiness counts and refs without raw
  memory bodies.
- [x] CLI output identifies ready, blocked, duplicate, conflict,
  repair-required, projected, importable, and approval-required states.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, or
  final UI behavior is added.

## Implementation Result

Added read-only review readiness diagnostics through:

- `AcceptedMemoryReviewReadinessQuery`
- `ServerQueryResult::AcceptedMemoryReviewReadiness`
- control-envelope request/response DTO conversion
- `nucleusd query accepted-memory-review-readiness --project <project-id>`
- Effigy selector `server:query:accepted-memory-review-readiness`

The bootstrap selector returns zero records and all effect flags false.

Focused validation passed:

- `cargo test -p nucleus-server accepted_memory_review_readiness -- --nocapture`
- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `cargo test -p nucleusd accepted_memory_review -- --nocapture`
- `cargo test -p nucleusd cli_config_parses_accepted_memory_review_readiness_query_domain -- --nocapture`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:accepted-memory-review-readiness`
