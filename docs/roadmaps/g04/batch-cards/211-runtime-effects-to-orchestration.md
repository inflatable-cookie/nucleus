# 211 Runtime Effects To Orchestration

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../046-engine-boundary-migration.md`
Auto-start next card: no

## Objective

Move the self-contained `runtime_effect_*` modules (events, replay,
retention, storage, subscriptions, transport) from nucleus-server to
nucleus-orchestration per contract 022.

## Steps

- relocate modules; keep server re-exports temporarily for consumers
- replace the empty placeholder modules in orchestration (`replay.rs`,
  `streams.rs`, `receipts.rs`) with the real implementations or delete them
- update contract 022 disposition checkboxes

## Acceptance

- [ ] modules live in orchestration with tests passing
- [ ] contract 022 list updated to reflect executed moves

## Validation

- `cargo test --workspace`

## Stop Conditions

- stop before redesigning the effect model; this is relocation only
