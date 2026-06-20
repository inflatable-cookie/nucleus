# 382 Durable Codex Live Smoke Replay Comparison

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../083-durable-codex-live-smoke-execution.md`

## Purpose

Compare durable live-smoke evidence against the task-backed replay fixture.

## Scope

- Rebuild task-backed live workflow projections from persisted evidence.
- Compare scheduler admission, live executor admission, outcome linkage,
  receipts, timeline, review separation, and diagnostics.
- Record differences as repair-required evidence, not automatic promotion.

## Acceptance Criteria

- [x] Matching evidence reports replay-equivalent.
- [x] Missing frame/decode/receipt evidence reports repair-required.
- [x] Review acceptance remains explicit and separate.
- [x] Diagnostics expose refs and blockers, not raw provider material.

## Result

Added `provider_durable_codex_live_smoke_replay`, comparing persisted durable
smoke evidence with the task-backed live workflow fixture and reporting missing
receipt/outcome/evidence refs or authority widening as repair-required gaps.

## Validation

- `cargo test -p nucleus-server durable_codex_live_smoke_replay -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
