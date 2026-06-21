# 046 Adapter-Neutral Chain Persistence Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../011-adapter-neutral-chain-persistence-control.md`

## Purpose

Define duplicate-safe persistence records for adapter-neutral chain projections.

## Acceptance Criteria

- [x] Persistence records preserve projection, stage, task, repo, and provider
  refs.
- [x] Duplicate projection ids produce duplicate outcomes.
- [x] Blocked and unsupported stages remain inspectable.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server adapter_neutral_change_request_chain_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
