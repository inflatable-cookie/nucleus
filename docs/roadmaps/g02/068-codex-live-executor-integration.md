# 068 Codex Live Executor Integration

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Promote the successful direct Codex smoke into a server-owned executor shape.

The one-off `nucleusd` smoke proved that Nucleus can initialize Codex
app-server, start an ephemeral read-only thread, send `turn/start`, observe
`turn/completed`, and retain only sanitized evidence. This lane turns that
evidence into durable records and diagnostics before provider writes are used
for task-backed work.

## Governing Refs

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/067-codex-direct-connection-smoke-gate.md`

## Goals

- [x] Record the live-smoke protocol sequence as the first executor fixture.
- [x] Add durable live executor outcome records without raw payload material.
- [x] Persist sanitized provider-write receipts and completion evidence.
- [x] Expose read-only diagnostics for live executor attempts.
- [x] Keep task mutation, callback responses, cancellation, and resume blocked.

## Non-Goals

- Do not build a general Codex session manager.
- Do not persist raw request payloads, raw JSON-RPC frames, stdout, stderr, or
  stream deltas.
- Do not let provider completion mutate task state.
- Do not add UI controls.
- Do not widen to callback responses, cancellation, resume, or worktree
  execution.

## Execution Plan

- [x] Evidence batch: promote the live-smoke sequence into an executor fixture
      and acceptance record.
- [x] Persistence batch: add sanitized live executor outcome and receipt
      records.
- [x] Diagnostics batch: route live executor outcomes through the existing
      read-only diagnostics surface.
- [x] Closeout batch: validate the executor lane and select the next runtime
      integration target.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/305-codex-live-executor-outcome-records.md`
- `batch-cards/306-codex-live-executor-receipt-persistence.md`
- `batch-cards/307-codex-live-executor-diagnostics.md`
- `batch-cards/308-codex-live-executor-integration-closeout.md`
- `batch-cards/304-codex-live-smoke-evidence-promotion.md`

## Acceptance Criteria

- [x] Live executor records distinguish accepted, completed, failed, timed-out,
      and cleanup-required states.
- [x] Records include provider instance, thread id, turn id, completion status,
      evidence refs, and receipt ids.
- [x] Records exclude raw prompt text, raw provider response text, raw frames,
      stdout, stderr, and stream deltas.
- [x] Diagnostics are read-only and do not grant provider command authority.
- [x] Validation passes or blockers are recorded.
