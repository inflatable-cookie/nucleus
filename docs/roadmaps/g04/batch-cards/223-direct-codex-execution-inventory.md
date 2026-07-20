# 223 Direct Codex Execution Inventory

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../050-swallowtail-task-execution-adoption.md`
Auto-start next card: yes

## Objective

Find every remaining direct Codex process or wire owner and distinguish shared
transport candidates from Nucleus-owned workflow and evidence machinery.

## Acceptance

- [x] live product execution transport is identified
- [x] diagnostic live transport is identified
- [x] supervision and durable evidence modules are classified
- [x] Swallowtail capability gaps are recorded
- [x] the next contract-first migration slice is bounded

## Evidence

- `local_codex_chat/task_execution.rs` directly owns one writable app-server
  process per task, JSON-RPC, a 15-minute turn deadline, callback
  classification, terminal outcomes, and cleanup.
- `apps/nucleusd/src/command_runner/codex_smoke/live.rs` and its `rpc.rs`
  directly own a separately confirmed read-only diagnostic smoke.
- no process, stdio, or network transport exists under `codex_supervision` or
  `codex_task_runtime`; those modules hold admission, identity, observations,
  receipts, persistence, recovery, and diagnostics.
- Swallowtail's current interactive Codex driver fixes read-only sandbox and
  no-approval policy, so task execution cannot adopt it until access policy is
  explicit and independently tested.

## Stop Condition

Do not infer that provider-specific Nucleus record names are reusable
transport mechanics merely because they mention Codex.
