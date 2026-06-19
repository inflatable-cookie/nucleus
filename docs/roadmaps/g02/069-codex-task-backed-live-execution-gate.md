# 069 Codex Task-Backed Live Execution Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Connect the persisted Codex live executor path to task-backed work without
letting provider completion mutate task state.

The previous lane proved explicit live execution, durable outcome persistence,
runtime receipts, and read-only diagnostics. This lane decides and implements
the first gate that can admit a task work item into live Codex execution while
keeping review, callback responses, cancellation, resume, SCM changes, and task
completion under separate authority.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/068-codex-live-executor-integration.md`

## Goals

- [x] Define the policy gate for task-backed live Codex execution.
- [x] Add task-work live executor admission records.
- [x] Link task work items to live executor receipts without task completion.
- [x] Expose read-only diagnostics for task-backed live execution attempts.
- [x] Keep callbacks, cancellation, resume, review acceptance, and SCM mutation
      outside this lane.

## Non-Goals

- Do not auto-complete tasks from provider `turn/completed`.
- Do not answer provider callbacks.
- Do not cancel or resume provider sessions.
- Do not create checkpoints, diffs, branches, worktrees, or change requests.
- Do not add UI controls.
- Do not expose a large flat tool menu to the task agent.
- Do not invent a next task outside the current task/goal/roadmap pathway.

## Execution Plan

- [x] Gate batch: define the policy gate and stop conditions for task-backed
      live execution.
- [x] Admission batch: record task-work-to-live-executor admission identity.
- [x] Receipt batch: link task work items to live executor outcomes and
      runtime receipts.
- [x] Diagnostics batch: expose read-only task-backed live execution state.
- [x] Closeout batch: validate the lane and select the next runtime target.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/309-task-backed-live-execution-policy-gate.md`
- `batch-cards/310-task-work-live-executor-admission-records.md`
- `batch-cards/311-task-work-live-executor-receipt-linkage.md`
- `batch-cards/312-task-backed-live-execution-diagnostics.md`
- `batch-cards/313-task-backed-live-execution-validation-closeout.md`

## Acceptance Criteria

- [x] Task-backed live execution has an explicit admission gate before any
      provider write.
- [x] Task work item refs link to live executor outcomes and runtime receipts.
- [x] Provider completion remains separate from task completion and operator
      review acceptance.
- [x] Diagnostics remain read-only and sanitized.
- [x] Validation passes or blockers are recorded.
