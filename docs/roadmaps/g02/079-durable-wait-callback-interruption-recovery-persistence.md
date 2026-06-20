# 079 Durable Wait Callback Interruption Recovery Persistence

Status: planned
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist wait, callback, interruption, and recovery evidence around the durable
executor path.

These records keep provider control states inspectable after restart without
answering callbacks, cancelling, resuming, or mutating tasks automatically.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/078-task-transition-admission-from-live-observations.md`

## Goals

- [ ] Persist callback request evidence.
- [ ] Link callback responses to durable dispatch/status records.
- [ ] Persist interruption outcomes.
- [ ] Persist recovery outcomes and repair requirements.
- [ ] Keep callback answering, cancellation, resume, and replacement-thread
      promotion operator-gated.

## Execution Plan

- [ ] Callback request batch.
- [ ] Callback response durable linkage batch.
- [ ] Interruption outcome persistence batch.
- [ ] Recovery outcome persistence batch.
- [ ] Closeout batch: validate and activate runtime hardening.

## Batch Cards

Ready cards:

None.

Planned cards:

- `batch-cards/359-callback-request-persistence.md`
- `batch-cards/360-callback-response-durable-linkage.md`
- `batch-cards/361-interruption-outcome-persistence.md`
- `batch-cards/362-recovery-outcome-persistence.md`
- `batch-cards/363-wait-callback-recovery-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Wait/callback/recovery evidence survives restart.
- [ ] Callback response and recovery decisions remain operator-gated.
- [ ] Replacement-thread promotion remains blocked.
- [ ] Validation passes or blockers are recorded.
