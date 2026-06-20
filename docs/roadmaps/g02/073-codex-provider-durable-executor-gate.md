# 073 Codex Provider Durable Executor Gate

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Move Codex provider writes from one-off smoke execution and compile-only
execution records toward a durable server-owned executor command path.

The previous runtime lanes established policy, executor admission, receipt
linkage, and diagnostics for task-backed turn-start work, callback responses,
interruptions, and recovery. The next gate should make execution requests
durable before any broader provider write automation is trusted.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/068-codex-live-executor-integration.md`
- `docs/roadmaps/g02/072-codex-provider-recovery-execution-gate.md`

## Goals

- [x] Define a durable provider executor command record.
- [x] Persist accepted executor command records in local state.
- [x] Add executor command status/readback records.
- [x] Expose read-only durable executor diagnostics.
- [x] Keep provider write execution behind explicit operator confirmation and
      existing lane policy/admission records.

## Non-Goals

- Do not add automatic background provider writes.
- Do not widen client command authority.
- Do not persist raw provider payloads, streams, stdout, stderr, or callback
  material.
- Do not complete tasks, accept reviews, promote replacement threads, answer
  callbacks, interrupt turns, resume sessions, or mutate SCM state from this
  gate.
- Do not design the final UI.

## Execution Plan

- [x] Command batch: define durable executor command records.
- [x] Persistence batch: store and replay accepted command records.
- [x] Status batch: add command status/readback records.
- [x] Diagnostics batch: expose durable executor command diagnostics.
- [x] Closeout batch: validate and select the next execution integration step.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/329-durable-provider-executor-command-records.md`
- `batch-cards/330-durable-provider-executor-command-persistence.md`
- `batch-cards/331-durable-provider-executor-status-records.md`
- `batch-cards/332-durable-provider-executor-diagnostics.md`
- `batch-cards/333-durable-provider-executor-validation-closeout.md`

## Acceptance Criteria

- [x] Executor command intent can be recorded without provider execution.
- [x] Command records preserve lane admission/write-attempt identity.
- [x] Persistence is sanitized and replayable.
- [x] Diagnostics are read-only and authority-free.
- [x] Validation passes or blockers are recorded.
