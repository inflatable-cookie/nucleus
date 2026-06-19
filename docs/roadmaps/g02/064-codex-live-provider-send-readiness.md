# 064 Codex Live Provider Send Readiness

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Prepare the first live provider send gate for Codex without jumping straight
from dry-run reactor records to stdio writes.

Roadmap `063` proved provider command reactor admission, queueing, dispatch,
outcome persistence, and Codex turn-start/callback dry-run routing. The next
risk is live-send authority: Codex writes need preflight evidence, transport
ownership, request identity, receipt/event persistence, and rollback/repair
posture before any real provider write is allowed.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/t3-code-comparison.md`

## Goals

- [x] Define Codex live-send preflight records and blockers.
- [x] Define provider transport write attempt records without raw payload
      retention.
- [x] Link Codex turn-start live-send attempts to runtime receipts/events.
- [x] Add a constrained live-send smoke boundary that can be disabled when
      auth, transport, or operator policy is missing.
- [x] Select whether the first real write is `turn/start` or callback response
      after preflight evidence exists.

## Non-Goals

- Do not mutate task state from provider observations.
- Do not retain raw provider payloads.
- Do not add UI panels.
- Do not add remote provider hosts.
- Do not widen cancellation, resume, or callback execution beyond this gate.

## Execution Plan

- [x] Live-send preflight batch: record execution authority, auth readiness,
      reactor readiness, transport readiness, and operator policy blockers.
- [x] Transport write attempt batch: model stdio write attempts, idempotency
      keys, and sanitized evidence refs before runtime write execution widens.
- [x] Turn-start live-send receipt batch: map turn-start write attempts into
      runtime receipt/event records without task mutation.
- [x] Constrained live-send smoke batch: add an opt-in execution boundary that
      stays disabled unless preflight evidence is complete.
- [x] Closeout batch: choose first real write target or record blockers.

## Batch Cards

Ready cards:

- None. Milestone complete.

Planned cards:

- None.

Completed cards:

- `batch-cards/286-codex-live-send-preflight-records.md`
- `batch-cards/287-provider-transport-write-attempt-records.md`
- `batch-cards/288-codex-turn-start-live-send-receipts.md`
- `batch-cards/289-codex-constrained-live-send-smoke-boundary.md`
- `batch-cards/290-codex-live-provider-send-closeout.md`

## Acceptance Criteria

- [x] Live provider send has explicit preflight records and blockers.
- [x] Transport write attempts are represented without raw provider payload
      retention.
- [x] Turn-start live-send attempts can map to runtime receipts/events.
- [x] Task mutation remains blocked.
- [x] Validation passes.

## Gate

Do not execute a live Codex write until preflight, transport write attempt,
runtime receipt/event, and operator policy records are explicit and tested.

Closeout selected Codex `turn/start` as the first real write target. Actual
provider execution is still blocked until explicit operator intent and a
transport-executor handoff are planned.
