# 070 Codex Callback Response Execution Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Move Codex callback responses from compile-only envelope/outcome records toward
a controlled execution path.

Task-backed live execution can now admit work, link outcomes, and expose
diagnostics without task completion. The next runtime target is provider
callback response execution because live Codex turns can request permission or
structured user input before useful loops can continue.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/069-codex-task-backed-live-execution-gate.md`

## Goals

- [x] Define the callback response execution policy gate.
- [x] Add callback response executor admission records.
- [x] Link callback response execution attempts to runtime receipts.
- [x] Expose read-only callback execution diagnostics.
- [x] Keep task completion, review acceptance, cancellation, resume, SCM
      mutation, and raw provider material retention outside this lane.

## Non-Goals

- Do not auto-answer provider callbacks.
- Do not bypass operator or task policy approval.
- Do not cancel or resume provider sessions.
- Do not complete tasks or accept reviews from callback response outcomes.
- Do not add UI controls.
- Do not retain raw callback prompt or response material.

## Execution Plan

- [x] Policy batch: define callback response execution gate and stop
      conditions.
- [x] Admission batch: record callback-response-to-executor identity.
- [x] Receipt batch: link callback response execution attempts to runtime
      receipts.
- [x] Diagnostics batch: expose read-only callback execution state.
- [x] Closeout batch: validate the lane and select the next runtime target.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/314-callback-response-execution-policy-gate.md`
- `batch-cards/315-callback-response-executor-admission-records.md`
- `batch-cards/316-callback-response-execution-receipt-linkage.md`
- `batch-cards/317-callback-response-execution-diagnostics.md`

## Acceptance Criteria

- [x] Callback response execution has an explicit gate before provider write.
- [x] Operator/task policy evidence is required before execution admission.
- [x] Callback execution attempts produce sanitized runtime receipts.
- [x] Diagnostics remain read-only and sanitized.
- [x] Validation passes or blockers are recorded.
