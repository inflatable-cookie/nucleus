# 065 Codex Turn Start Transport Executor Handoff

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Plan and implement the next Codex runtime lane after live-send readiness:
the handoff from record-only `turn/start` send readiness to a constrained
transport executor boundary.

Roadmap `064` selected Codex `turn/start` as the first real provider write
target. This lane must not jump directly to broad live provider behavior. The
first useful goal is an explicit executor handoff with authority records,
sanitized execution envelopes, persistence, frame/decode evidence, diagnostics,
and a stopped-by-default smoke gate.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/t3-code-comparison.md`

## Goals

- [x] Define transport-executor authority and operator confirmation records.
- [x] Define the sanitized `turn/start` stdio write execution envelope.
- [x] Persist transport execution attempts, receipts, and event refs.
- [x] Persist stdio frame source and decode evidence for the first response
      path.
- [x] Expose executor diagnostics without raw provider payload retention.
- [x] Keep task mutation, callback response execution, provider cancellation,
      and resume widening blocked.
- [x] Decide the next runtime lane after executor handoff.

## Non-Goals

- Do not execute an unconfirmed live Codex write.
- Do not retain raw provider payloads or full stdio streams.
- Do not complete task work from provider observations.
- Do not answer provider callbacks.
- Do not widen provider-reaching cancellation or resume.
- Do not add UI panels.
- Do not add remote provider hosts.

## Execution Plan

- [x] Executor authority batch: model execution host, provider instance,
      operator confirmation, and no-task-mutation policy.
- [x] Write envelope batch: build the sanitized `turn/start` transport
      execution envelope from existing preflight/write/receipt evidence.
- [x] Persistence batch: persist attempted execution refs, receipts, and
      event-store records without raw payloads.
- [x] Ingestion batch: persist stdio frame source/decode evidence for the
      first provider response path.
- [x] Diagnostics batch: route executor readiness, attempts, receipts, and
      blockers through read-only diagnostics.
- [x] Smoke boundary batch: keep live execution blocked by default and require
      explicit operator confirmation for any real write.
- [x] Closeout batch: choose the next runtime lane or record blockers.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/291-codex-transport-executor-authority-records.md`
- `batch-cards/292-codex-turn-start-stdio-execution-envelope.md`
- `batch-cards/293-codex-transport-execution-persistence.md`
- `batch-cards/294-codex-stdio-frame-ingestion-persistence.md`
- `batch-cards/295-codex-transport-executor-diagnostics.md`
- `batch-cards/296-codex-turn-start-executor-smoke-boundary.md`
- `batch-cards/297-codex-transport-executor-closeout.md`

## Acceptance Criteria

- [x] A transport executor cannot run without explicit authority records.
- [x] `turn/start` execution evidence preserves request, envelope, command,
      preflight, write attempt, receipt, and provider instance identity.
- [x] Transport execution persistence is sanitized and replay-safe.
- [x] First response frame/decode evidence can be recorded without raw payload
      retention.
- [x] Diagnostics expose readiness and blockers without client authority.
- [x] Task mutation remains blocked.
- [x] Validation passes.

## Gate

The executor handoff path can now prepare authority, envelope, persistence,
frame/decode evidence, diagnostics, and a stopped-by-default real-write smoke
boundary.

Do not perform a real Codex `turn/start` write until the operator explicitly
selects that lane and confirms the write may run.
