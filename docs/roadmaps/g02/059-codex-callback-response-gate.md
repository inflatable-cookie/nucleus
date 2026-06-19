# 059 Codex Callback Response Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Define callback request and response handling for Codex provider interactions.

Roadmap `058` stopped before answering provider callbacks. This lane should add
the callback request, admission, response-envelope, receipt, and diagnostics
boundary for permission and user-input callbacks.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add callback request records for provider permission and user-input
      callbacks.
- [x] Gate callback responses through authority, callback type, and retention
      policy.
- [x] Map accepted callback responses to sanitized provider envelope records.
- [x] Expose callback outcomes through receipts and read-only diagnostics.
- [x] Keep cancellation, recovery, and task mutation out of scope.

## Non-Goals

- Do not implement provider-reaching cancellation.
- Do not implement resume/recovery execution.
- Do not mutate task state from provider observations.
- Do not add UI panels.

## Execution Plan

- [x] Request batch: add callback request records.
- [x] Admission batch: gate callback response policy.
- [x] Envelope batch: map accepted callback responses to provider envelopes.
- [x] Receipts/diagnostics batch: expose callback outcomes safely.
- [x] Closeout batch: validate and select cancellation, recovery, or
      task-mutation as the next gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/261-codex-callback-request-records.md`
- `batch-cards/262-codex-callback-response-admission.md`
- `batch-cards/263-codex-callback-response-envelope.md`
- `batch-cards/264-codex-callback-receipts-diagnostics.md`
- `batch-cards/265-codex-callback-closeout.md`

## Acceptance Criteria

- [x] Callback requests preserve provider and Nucleus identity.
- [x] Callback response admission blocks unsupported or unauthorized responses.
- [x] Response envelopes are sanitized and replay-safe.
- [x] Receipts and diagnostics exclude raw provider payloads.
- [x] Validation passes.

## Gate

Callback response state is explicit and tested. Next gate:
`060-codex-provider-interruption-gate.md`.
