# 033 Codex Task Event Ingestion And Receipts

Status: planned
Owner: Tom
Updated: 2026-06-18

## Purpose

Map Codex runtime observations into task work-unit progress and receipts.

## Governing Refs

- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/roadmaps/g02/014-codex-live-runtime-supervision.md`

## Goals

- [ ] Map Codex events to task progress without raw provider payload storage.
- [ ] Link command/tool receipts to work-unit state.
- [ ] Preserve permission prompts and human approval waits.
- [ ] Classify retryable, terminal, and recovery-required failures.

## Execution Plan

- [ ] Progress batch: project Codex observations into work-unit progress.
- [ ] Receipt batch: connect tool/command refs to runtime receipts.
- [ ] Approval batch: preserve wait states and permission prompts.
- [ ] Failure batch: classify retry and recovery states.
- [ ] Validation batch: replay fixtures deterministically.

## Batch Cards

Planned cards:

- `batch-cards/144-codex-task-progress-event-mapping.md`
- `batch-cards/145-codex-task-command-receipt-linkage.md`
- `batch-cards/146-codex-task-permission-wait-states.md`
- `batch-cards/147-codex-task-error-retry-classification.md`
- `batch-cards/148-codex-task-event-ingestion-validation.md`

## Acceptance Criteria

- [ ] Work-unit progress can be rebuilt from Codex observations.
- [ ] Receipts reference sanitized evidence only.
- [ ] Wait and failure states are explicit.

## Gate

Do not store raw provider payloads to make projections easier.
