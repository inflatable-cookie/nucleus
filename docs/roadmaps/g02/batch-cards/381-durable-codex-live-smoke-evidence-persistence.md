# 381 Durable Codex Live Smoke Evidence Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../083-durable-codex-live-smoke-execution.md`

## Purpose

Persist sanitized durable live-smoke outcome evidence.

## Scope

- Persist live executor outcome records.
- Persist runtime receipts.
- Persist frame/decode/observation evidence where available.
- Reject raw provider payloads, raw streams, secrets, credentials, and
  unbounded local paths.

## Acceptance Criteria

- [x] Persisted evidence survives store reopen.
- [x] Duplicate write attempt ids are deterministic no-ops or blocked records.
- [x] Raw provider material is rejected at retention boundaries.
- [x] Evidence can be queried through read-only diagnostics.

## Result

Added `provider_durable_codex_live_smoke_persistence`, which persists sanitized
smoke evidence plus accepted live-executor outcome/receipt refs for first write
attempts, while duplicate write attempts no-op and retention failures block.

## Validation

- `cargo test -p nucleus-server durable_codex_live_smoke_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
