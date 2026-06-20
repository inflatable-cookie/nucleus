# 084 Durable Codex Live Provider Write Invocation

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Add the explicit invocation gate for one durable Codex live provider-write
smoke.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/083-durable-codex-live-smoke-execution.md`

## Goals

- [x] Define the invocation gate over an eligible durable smoke boundary.
- [x] Expose a `nucleusd` command that remains stopped by default.
- [x] Capture sanitized live invocation evidence.
- [x] Reconcile persisted evidence with replay comparison.
- [x] Keep broad provider automation gated.

## Execution Plan

- [x] Invocation gate batch.
- [x] CLI command batch.
- [x] Evidence capture batch.
- [x] Replay reconciliation batch.
- [x] Validation closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/384-durable-codex-live-provider-write-invocation-gate.md`
- `batch-cards/385-nucleusd-durable-live-provider-write-smoke-command.md`
- `batch-cards/386-durable-live-provider-write-evidence-capture.md`
- `batch-cards/387-durable-live-provider-write-replay-reconciliation.md`
- `batch-cards/388-durable-live-provider-write-validation-closeout.md`

## Acceptance Criteria

- [x] Provider write cannot execute without eligible boundary, confirmation,
      and effect flag.
- [x] Invocation result captures sanitized ids, counts, statuses, and evidence
      refs only.
- [x] Persisted evidence reconciles with durable replay comparison.
- [x] Callback, cancellation, resume, task, review, and SCM authority remain
      separate.
