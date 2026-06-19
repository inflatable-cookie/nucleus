# 053 Harness Runtime Rebaseline

Status: active
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

- [ ] Review harness runtime contract gaps.
- [ ] Audit current Codex runtime code against contracts.
- [ ] Rebaseline provider session and event ingestion boundaries.
- [ ] Prepare the next implementation runway without expanding UI or SCM.

## Execution Plan

- [ ] Contract batch: check harness/session/timeline/receipt contracts.
- [ ] Code batch: audit current Codex runtime modules and adapter surfaces.
- [ ] Boundary batch: define next provider-session and event-ingestion gates.
- [ ] Closeout batch: prepare the next ready implementation card or pause gate.

## Batch Cards

Ready cards:

- `batch-cards/230-harness-runtime-contract-gap-review.md`

Planned cards:

- `batch-cards/231-codex-runtime-code-audit.md`
- `batch-cards/232-provider-session-boundary-rebaseline.md`
- `batch-cards/233-harness-event-ingestion-runway.md`
- `batch-cards/234-harness-runtime-rebaseline-closeout.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Harness runtime gaps are current and visible.
- [ ] Codex runtime code is mapped to the contracts it already satisfies.
- [ ] The next implementation step is bounded and ready, or explicitly paused.
- [ ] Roadmap front doors point at one clear next task.

## Gate

Do not add provider execution behavior until this rebaseline confirms the
session, event, receipt, and recovery boundaries.
