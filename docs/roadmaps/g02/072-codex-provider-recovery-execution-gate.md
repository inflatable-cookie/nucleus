# 072 Codex Provider Recovery Execution Gate

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Move Codex recovery requests from compile-only need/admission/envelope/outcome
records toward a controlled execution path.

Turn-start sends, task-backed execution, callback response execution, and
interruption execution now have policy, admission, receipt linkage, and
diagnostics lanes. The next runtime target is provider recovery because server
restart, process exit, reconnect, and provider identity mismatch need
server-owned repair/resume behavior without granting clients raw provider
control.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/071-codex-provider-interruption-execution-gate.md`

## Goals

- [x] Define the provider recovery execution policy gate.
- [x] Add provider recovery executor admission records.
- [x] Link recovery execution attempts to runtime receipts.
- [x] Expose read-only recovery execution diagnostics.
- [x] Keep task completion, review acceptance, interruption, callback
      answering, SCM mutation, replacement-thread promotion, and raw provider
      material retention outside this lane.

## Non-Goals

- Do not add UI controls.
- Do not auto-resume provider sessions without operator/task policy evidence.
- Do not promote replacement provider threads.
- Do not complete tasks or accept reviews from recovery outcomes.
- Do not answer callbacks or interrupt turns from recovery execution.
- Do not mutate SCM state.
- Do not retain raw provider stream or callback material.

## Execution Plan

- [x] Policy batch: define recovery execution gate and stop conditions.
- [x] Admission batch: record recovery-to-executor identity.
- [x] Receipt batch: link recovery execution attempts to runtime receipts.
- [x] Diagnostics batch: expose read-only recovery execution state.
- [x] Closeout batch: validate the lane and select the next runtime target.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/324-provider-recovery-execution-policy-gate.md`
- `batch-cards/325-provider-recovery-executor-admission-records.md`
- `batch-cards/326-provider-recovery-execution-receipt-linkage.md`
- `batch-cards/327-provider-recovery-execution-diagnostics.md`
- `batch-cards/328-provider-recovery-execution-validation-closeout.md`

## Acceptance Criteria

- [x] Recovery execution has an explicit gate before provider write.
- [x] Operator/task policy evidence is required before execution admission.
- [x] Recovery attempts produce sanitized runtime receipts.
- [x] Diagnostics remain read-only and sanitized.
- [x] Validation passes or blockers are recorded.
