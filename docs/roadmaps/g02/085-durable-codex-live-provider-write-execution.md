# 085 Durable Codex Live Provider Write Execution

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Execute one explicitly confirmed Codex live provider-write smoke through the
durable invocation, evidence, and replay path from roadmap `084`.

## Governing Refs

- `docs/roadmaps/g02/084-durable-codex-live-provider-write-invocation.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Reuse the existing Codex `turn/start` live runner as the transport.
- [x] Convert live smoke outcomes into durable provider-write evidence.
- [x] Persist successful and terminal outcomes without raw provider material.
- [x] Reconcile persisted evidence before widening runtime authority.
- [x] Keep task, review, callback, cancellation, resume, and SCM authority gated.

## Execution Plan

- [x] Durable live runner bridge batch.
- [x] `nucleusd` execution command batch.
- [x] Live result persistence and replay batch.
- [x] Failure/cleanup evidence batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/389-durable-live-provider-write-runner-bridge.md`
- `batch-cards/390-nucleusd-durable-live-provider-write-execute-command.md`
- `batch-cards/391-durable-live-provider-write-result-persistence.md`
- `batch-cards/392-durable-live-provider-write-terminal-outcomes.md`
- `batch-cards/393-durable-live-provider-write-execution-closeout.md`

## Acceptance Criteria

- [x] A live Codex provider write can only run after explicit confirmation and
      effect flags.
- [x] Successful live outcomes persist thread, turn, status, counts, receipt,
      and evidence refs.
- [x] Failed, blocked, timed-out, and cleanup-required outcomes remain
      inspectable.
- [x] Replay reconciliation passes before task or review state changes.
- [x] Raw payloads, raw streams, secrets, task mutation, review acceptance,
      callback response, cancellation, resume, and SCM mutation stay gated.
