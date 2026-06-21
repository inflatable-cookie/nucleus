# 043 Adapter-Neutral Chain Projection Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../010-adapter-neutral-change-request-chain-projection.md`

## Purpose

Define adapter-neutral change-request chain projection records from provider
specific stages.

## Acceptance Criteria

- [x] Projection records distinguish neutral stage family from provider-specific
  refs.
- [x] Git-like stages can be represented without becoming universal.
- [x] Convergence-like publication stages can be represented.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server adapter_neutral_change_request_chain -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
