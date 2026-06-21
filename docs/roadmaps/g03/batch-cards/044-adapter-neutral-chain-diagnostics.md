# 044 Adapter-Neutral Chain Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../010-adapter-neutral-change-request-chain-projection.md`

## Purpose

Summarize adapter-neutral chain projections without granting execution
authority.

## Acceptance Criteria

- [x] Diagnostics count stage families.
- [x] Diagnostics count provider-specific refs.
- [x] Diagnostics count blockers.
- [x] Diagnostics grant no execution authority.

## Validation

- `cargo test -p nucleus-server adapter_neutral_change_request_chain_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
