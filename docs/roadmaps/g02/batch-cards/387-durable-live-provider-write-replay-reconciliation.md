# 387 Durable Live Provider Write Replay Reconciliation

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../084-durable-codex-live-provider-write-invocation.md`

## Purpose

Reconcile durable live provider-write evidence with replay projections.

## Scope

- Compare live write evidence against durable smoke replay comparison.
- Record repair-required gaps for missing frame, decode, receipt, or outcome
  evidence.
- Preserve review acceptance as explicit operator action only.

## Acceptance Criteria

- [x] Matching evidence reconciles.
- [x] Missing evidence reports repair-required.
- [x] No task completion or review acceptance is promoted automatically.
- [x] Diagnostics remain read-only.

## Result

Added durable live provider-write replay reconciliation with repair-required
gaps for missing durable evidence and no task/review promotion.

## Validation

- `cargo test -p nucleus-server durable_live_provider_write_replay -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
