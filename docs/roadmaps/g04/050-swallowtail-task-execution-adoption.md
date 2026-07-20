# 050 Swallowtail Task Execution Adoption

Status: active
Owner: Tom
Updated: 2026-07-20

## Purpose

Move the remaining reusable Codex process and wire mechanics behind
Swallowtail without moving Nucleus task authority, execution policy, durable
receipts, review semantics, or recovery state out of Nucleus.

## Governing Refs

- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../contracts/023-task-backed-agent-workflow-contract.md`
- `../../contracts/020-runtime-receipt-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`
- `../../architecture/system-inventory.md`

## Execution Plan

- [x] Inventory remaining direct Codex transports and separate transport from
  Nucleus-owned domain machinery.
- [x] Promote the writable task-execution and diagnostic-smoke contract in
  both Nucleus and Swallowtail.
- [x] Add the minimum Swallowtail access-policy support required by bounded
  workspace task execution.
- [x] Replace Nucleus task execution transport behind a focused consumer
  facade while preserving linkage and outcomes.
- [x] Consolidate the daemon's direct smoke on the shared runtime or retire it
  if its evidence is fully superseded.
- [ ] Prove native Goal/task execution parity before removing direct transport.

## Boundary Decisions

- `local_codex_chat/task_execution.rs` now resolves the Swallowtail-backed
  `TaskExecutionRuntime`; it owns no Codex process or wire code.
- `apps/nucleusd/.../codex_smoke/live.rs` remains a separately confirmed
  diagnostic facade over the Swallowtail read-only runner, not a product task
  runtime.
- `codex_supervision`, `codex_task_runtime`, durable evidence stores, Goal run
  composition, mandates, review, and task receipts remain Nucleus concerns.
- Swallowtail's current app-server session is deliberately read-only. Writable
  task execution must be promoted there explicitly; Agent Chat options must
  not be silently widened.

## Acceptance Criteria

- no product task-execution code writes Codex app-server JSON-RPC directly
- workspace-write, writable roots, network denial, approval posture, timeout,
  callbacks, terminal outcomes, and cleanup have explicit cross-repo contracts
- Nucleus retains session/task/work-item/receipt identity and persistence
- completed, waiting, cancelled, failed, and recovery-required outcomes retain
  current semantics
- authenticated task and two-task Goal workflows retain review-ready evidence

## Batch Cards

- `batch-cards/223-direct-codex-execution-inventory.md` — completed
- `batch-cards/224-swallowtail-writable-execution-contract.md` — completed
- `batch-cards/225-swallowtail-writable-session-driver.md` — completed
- `batch-cards/226-nucleus-task-executor-adoption.md` — completed
- `batch-cards/227-codex-smoke-consolidation.md` — completed
- `batch-cards/228-task-execution-validation-closeout.md` — ready

## Stop Condition

Stop if the migration would put Nucleus mandates, task lifecycle, Goal
ordering, review state, durable receipts, SCM publication, or host-placement
policy inside Swallowtail.
