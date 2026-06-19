# 071 Codex Provider Interruption Execution Gate

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Move Codex interruption requests from compile-only admission/envelope/outcome
records toward a controlled execution path.

Turn-start sends, task-backed live execution, and callback response execution
now have policy, admission, receipt linkage, and diagnostics lanes. The next
runtime target is provider interruption because long-running turns need a
server-owned way to stop work without granting clients direct provider control.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/070-codex-callback-response-execution-gate.md`

## Goals

- [x] Define the provider interruption execution policy gate.
- [ ] Add provider interruption executor admission records.
- [ ] Link interruption execution attempts to runtime receipts.
- [ ] Expose read-only interruption execution diagnostics.
- [ ] Keep task completion, review acceptance, resume, callback answering, SCM
      mutation, and raw provider material retention outside this lane.

## Non-Goals

- Do not add UI controls.
- Do not auto-cancel provider work without operator/task policy evidence.
- Do not resume provider sessions.
- Do not complete tasks or accept reviews from interruption outcomes.
- Do not mutate SCM state.
- Do not retain raw provider stream or callback material.

## Execution Plan

- [x] Policy batch: define interruption execution gate and stop conditions.
- [ ] Admission batch: record interruption-to-executor identity.
- [ ] Receipt batch: link interruption execution attempts to runtime receipts.
- [ ] Diagnostics batch: expose read-only interruption execution state.
- [ ] Closeout batch: validate the lane and select the next runtime target.

## Batch Cards

Ready cards:

- `batch-cards/320-provider-interruption-executor-admission-records.md`

Planned cards:

- `batch-cards/321-provider-interruption-execution-receipt-linkage.md`
- `batch-cards/322-provider-interruption-execution-diagnostics.md`
- `batch-cards/323-provider-interruption-execution-validation-closeout.md`

Completed cards:

- `batch-cards/319-provider-interruption-execution-policy-gate.md`

## Acceptance Criteria

- [x] Interruption execution has an explicit gate before provider write.
- [x] Operator/task policy evidence is required before execution admission.
- [ ] Interruption attempts produce sanitized runtime receipts.
- [ ] Diagnostics remain read-only and sanitized.
- [ ] Validation passes or blockers are recorded.
