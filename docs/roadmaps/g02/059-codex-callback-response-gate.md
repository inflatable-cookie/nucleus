# 059 Codex Callback Response Gate

Status: active
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

- [ ] Add callback request records for provider permission and user-input
      callbacks.
- [ ] Gate callback responses through authority, callback type, and retention
      policy.
- [ ] Map accepted callback responses to sanitized provider envelope records.
- [ ] Expose callback outcomes through receipts and read-only diagnostics.
- [ ] Keep cancellation, recovery, and task mutation out of scope.

## Non-Goals

- Do not implement provider-reaching cancellation.
- Do not implement resume/recovery execution.
- Do not mutate task state from provider observations.
- Do not add UI panels.

## Execution Plan

- [ ] Request batch: add callback request records.
- [ ] Admission batch: gate callback response policy.
- [ ] Envelope batch: map accepted callback responses to provider envelopes.
- [ ] Receipts/diagnostics batch: expose callback outcomes safely.
- [ ] Closeout batch: validate and select cancellation, recovery, or
      task-mutation as the next gate.

## Batch Cards

Ready cards:

- `batch-cards/261-codex-callback-request-records.md`

Planned cards:

- `batch-cards/262-codex-callback-response-admission.md`
- `batch-cards/263-codex-callback-response-envelope.md`
- `batch-cards/264-codex-callback-receipts-diagnostics.md`
- `batch-cards/265-codex-callback-closeout.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Callback requests preserve provider and Nucleus identity.
- [ ] Callback response admission blocks unsupported or unauthorized responses.
- [ ] Response envelopes are sanitized and replay-safe.
- [ ] Receipts and diagnostics exclude raw provider payloads.
- [ ] Validation passes.

## Gate

Do not cancel provider work, resume sessions, or mutate tasks until callback
response state is explicit and tested.
