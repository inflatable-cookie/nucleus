# 074 Codex Durable Executor Dispatch Gate

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Move durable provider executor commands toward a server-owned dispatch path
without enabling automatic background provider writes.

The durable command gate now records accepted executor intent, persists it,
tracks status, and exposes read-only diagnostics. The next lane should define
how queued commands are selected, admitted to dispatch, and reconciled with the
existing live executor outcome records.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/073-codex-provider-durable-executor-gate.md`

## Goals

- [x] Define dispatch selection records for durable executor commands.
- [x] Add dispatch admission records that require explicit operator
      confirmation and accepted command/status state.
- [x] Link dispatch attempts to live executor outcome persistence.
- [x] Expose read-only dispatch diagnostics.
- [x] Keep automatic background execution, task mutation, review acceptance,
      callback answering, interruption, recovery promotion, SCM mutation, and
      raw provider material retention outside this lane.

## Non-Goals

- Do not add unattended provider execution.
- Do not add UI controls.
- Do not bypass lane-specific policy/admission records.
- Do not complete tasks, accept reviews, answer callbacks, interrupt turns,
  resume sessions, promote replacement threads, or mutate SCM state.
- Do not persist raw provider payloads, streams, stdout, stderr, or callback
  material.

## Execution Plan

- [x] Selection batch: define queued command selection/readiness records.
- [x] Admission batch: gate dispatch with operator confirmation and command
      status evidence.
- [x] Linkage batch: map dispatch attempts to persisted live executor
      outcomes and durable status records.
- [x] Diagnostics batch: expose dispatch readiness/progress diagnostics.
- [x] Closeout batch: validate and select the next execution integration step.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/334-durable-executor-dispatch-selection-records.md`
- `batch-cards/335-durable-executor-dispatch-admission.md`
- `batch-cards/336-durable-executor-dispatch-outcome-linkage.md`
- `batch-cards/337-durable-executor-dispatch-diagnostics.md`
- `batch-cards/338-durable-executor-dispatch-validation-closeout.md`

## Acceptance Criteria

- [x] Queued durable commands can be selected without provider execution.
- [x] Dispatch admission requires explicit operator confirmation.
- [x] Dispatch linkage reuses sanitized live executor outcome persistence.
- [x] Diagnostics are read-only and authority-free.
- [x] Validation passes or blockers are recorded.
