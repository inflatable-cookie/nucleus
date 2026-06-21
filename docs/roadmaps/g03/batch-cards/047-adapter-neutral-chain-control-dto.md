# 047 Adapter-Neutral Chain Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../011-adapter-neutral-chain-persistence-control.md`

## Purpose

Expose adapter-neutral change-request chain diagnostics through read-only
control DTOs.

## Acceptance Criteria

- [x] DTOs summarize persisted projections and diagnostics.
- [x] DTOs expose duplicate, blocked, unsupported, and ready counts.
- [x] DTOs carry no mutation authority.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server adapter_neutral_change_request_chain_control -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
