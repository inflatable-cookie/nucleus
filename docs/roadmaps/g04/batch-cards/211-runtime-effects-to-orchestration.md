# 211 Runtime Effects To Orchestration

Status: completed
Owner: Claude
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

- [x] all six runtime_effect modules live in orchestration with tests
  passing; client identity vocabulary moved to
  `nucleus-orchestration::host_identity` (ClientConnection stays
  server-side); server keeps re-export shims so no consumer churn
- [x] one-line placeholder modules (`replay.rs`, `streams.rs`,
  `receipts.rs`) deleted from orchestration
- [x] contract 022 list updated with move dates

## Validation

- `cargo test --workspace`

## Stop Conditions

- stop before redesigning the effect model; this is relocation only
