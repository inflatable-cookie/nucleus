# 033 Codex Task Event Ingestion And Receipts

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Map Codex runtime observations into task work-unit progress and receipts.

## Governing Refs

- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/roadmaps/g02/014-codex-live-runtime-supervision.md`

## Goals

- [x] Map Codex events to task progress without raw provider payload storage.
- [x] Link command/tool receipts to work-unit state.
- [x] Preserve permission prompts and human approval waits.
- [x] Classify retryable, terminal, and recovery-required failures.

## Execution Plan

- [x] Progress batch: project Codex observations into work-unit progress.
- [x] Receipt batch: connect tool/command refs to runtime receipts.
- [x] Approval batch: preserve wait states and permission prompts.
- [x] Failure batch: classify retry and recovery states.
- [x] Validation batch: replay fixtures deterministically.

## Batch Cards

Completed cards:

- `batch-cards/144-codex-task-progress-event-mapping.md`
- `batch-cards/145-codex-task-command-receipt-linkage.md`
- `batch-cards/146-codex-task-permission-wait-states.md`
- `batch-cards/147-codex-task-error-retry-classification.md`
- `batch-cards/148-codex-task-event-ingestion-validation.md`

## Acceptance Criteria

- [x] Work-unit progress can be rebuilt from Codex observations.
- [x] Receipts reference sanitized evidence only.
- [x] Wait and failure states are explicit.

## Result

Task-scoped Codex progress events, receipt links, wait progress, and error
classification are implemented without raw provider payload storage.

## Gate

Do not store raw provider payloads to make projections easier.
