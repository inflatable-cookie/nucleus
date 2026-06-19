# 058 Codex Turn Start Send And Subscription Gate

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Define the provider-send and subscription boundary for accepted Codex
turn-start envelopes.

Roadmap `057` stopped before provider writes. This lane should add the next
bounded layer: command boundary for provider send, stdio write/subscription
state records, sanitized receipts, and diagnostics.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add provider-send command boundary records for accepted turn-start
      envelopes.
- [ ] Add stdio write and subscription state records without raw stream
      retention.
- [ ] Map send/subscription outcomes to sanitized receipts.
- [ ] Expose send/subscription diagnostics without command authority.
- [ ] Keep callbacks, cancellation, recovery, and task mutation out of scope.

## Non-Goals

- Do not answer permission or user-input callbacks.
- Do not implement provider-reaching cancellation.
- Do not implement resume/recovery execution.
- Do not mutate task state from provider observations.
- Do not add UI panels.

## Execution Plan

- [x] Command boundary batch: add provider-send command records.
- [ ] Subscription state batch: add stdio write and subscription records.
- [ ] Receipt batch: map send/subscription outcomes to sanitized receipts.
- [ ] Diagnostics batch: expose send/subscription state read-only.
- [ ] Closeout batch: validate and select callback, cancellation, recovery, or
      task-mutation as the next gate.

## Batch Cards

Ready cards:

- `batch-cards/257-codex-stdio-write-subscription-state.md`

Planned cards:

- `batch-cards/258-codex-turn-start-send-receipts.md`
- `batch-cards/259-codex-subscription-diagnostics.md`
- `batch-cards/260-codex-send-subscription-closeout.md`

Completed cards:

- `batch-cards/256-codex-provider-send-command-boundary.md`

## Acceptance Criteria

- [x] Provider send cannot start without an accepted turn-start envelope.
- [ ] Subscription state is explicit and replay-safe.
- [ ] Receipts and diagnostics exclude raw prompts/provider payloads.
- [ ] Callback/cancellation/recovery/task-mutation behavior remains blocked.
- [ ] Validation passes.

## Gate

Do not answer callbacks, cancel provider work, resume sessions, or mutate tasks
until provider send/subscription state is explicit and tested.
