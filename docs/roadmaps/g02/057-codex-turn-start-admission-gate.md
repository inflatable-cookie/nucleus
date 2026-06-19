# 057 Codex Turn Start Admission Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Define the first provider turn-start boundary after live spawn smoke.

Roadmap `056` proved a bounded server-side smoke path. This lane should define
and implement the request/admission/envelope shape for starting a Codex turn
without answering callbacks, performing cancellation, resuming sessions, or
letting provider observations mutate task state.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add Codex turn-start request records linked to runtime, session, and work
      refs.
- [x] Gate turn-start admission through live-spawn evidence, task-work
      readiness, payload retention, and callback posture.
- [x] Map accepted turn-start requests to provider envelope records without
      sending callbacks or retaining raw payloads.
- [x] Map accepted, blocked, failed, and unsupported turn-start outcomes to
      sanitized receipts and diagnostics.
- [x] Keep task mutation out of scope until runtime observations are accepted
      by a later gate.

## Non-Goals

- Do not answer permission or user-input callbacks.
- Do not implement provider-reaching cancellation.
- Do not implement resume/recovery execution.
- Do not subscribe to long-running event streams beyond existing ingestion
  records.
- Do not mutate task state from provider observations.
- Do not add UI panels.

## Execution Plan

- [x] Request batch: add turn-start request records.
- [x] Admission batch: gate turn-start policy before provider send.
- [x] Envelope batch: map accepted requests to provider envelope records.
- [x] Receipts/diagnostics batch: expose outcomes through sanitized receipts
      and read-only diagnostics.
- [x] Closeout batch: validate and select callback, cancellation, recovery,
      subscription, or task-mutation as the next gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/251-codex-turn-start-request-records.md`
- `batch-cards/252-codex-turn-start-admission-policy.md`
- `batch-cards/253-codex-turn-start-envelope-mapping.md`
- `batch-cards/254-codex-turn-start-receipts-diagnostics.md`
- `batch-cards/255-codex-turn-start-closeout.md`

## Acceptance Criteria

- [x] Turn-start cannot be requested without runtime/session/work refs.
- [x] Admission is blocked without live-spawn evidence and task-work readiness.
- [x] Provider envelope records are sanitized and replay-safe.
- [x] Receipts and diagnostics expose outcomes without command authority.
- [x] Validation passes.

## Result

Codex turn-start admission gate is complete as a pre-send boundary.

Implemented:

- turn-start request records over Nucleus-owned runtime/session/task/work refs
- admission policy with explicit deferred callback and cancellation posture
- sanitized `turn/start` envelope records
- turn-start outcome receipt mapping and read-only diagnostics

Not implemented:

- provider send/write
- event subscription lifecycle
- callback responses
- provider-reaching cancellation
- resume/recovery execution
- task mutation from provider observations

Next gate: `058-codex-turn-start-send-and-subscription-gate.md`.

## Gate

Do not answer provider callbacks, cancel provider work, resume sessions, or
mutate tasks until turn-start admission and envelopes are explicit and tested.
