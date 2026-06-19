# 053 Harness Runtime Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Rebaseline harness runtime contracts and current Codex runtime code before
opening more provider behavior.

The red health gate is clear. The next risk is letting provider runtime work
spread across server, adapter, protocol, and engine crates without a current
boundary review.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Review harness runtime contract gaps.
- [x] Audit current Codex runtime code against contracts.
- [x] Rebaseline provider session and event ingestion boundaries.
- [x] Prepare the next implementation runway without expanding UI or SCM.

## Execution Plan

- [x] Contract batch: check harness/session/timeline/receipt contracts.
- [x] Code batch: audit current Codex runtime modules and adapter surfaces.
- [x] Boundary batch: define next provider-session and event-ingestion gates.
- [x] Closeout batch: prepare the next ready implementation card or pause gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/230-harness-runtime-contract-gap-review.md`
- `batch-cards/231-codex-runtime-code-audit.md`
- `batch-cards/232-provider-session-boundary-rebaseline.md`
- `batch-cards/233-harness-event-ingestion-runway.md`
- `batch-cards/234-harness-runtime-rebaseline-closeout.md`

## Acceptance Criteria

- [x] Harness runtime gaps are current and visible.
- [x] Codex runtime code is mapped to the contracts it already satisfies.
- [x] The next implementation step is bounded and ready, or explicitly paused.
- [x] Roadmap front doors point at one clear next task.

## Result

The current Codex runtime is a boundary proof:

- metadata-only adapter descriptor
- fixture-backed projection into canonical runtime events and receipts
- compile-only supervision, handshake, wait-state, task admission, progress,
  receipt-link, and recovery-gate records

It is not a live provider runtime. The next lane is
`054-codex-live-event-acceptance.md`, focused on durable session bindings and
accepted provider event records before provider command execution expands.

## Gate

Do not add provider execution behavior until this rebaseline confirms the
session, event, receipt, and recovery boundaries.
