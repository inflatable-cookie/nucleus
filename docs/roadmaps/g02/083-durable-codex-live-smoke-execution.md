# 083 Durable Codex Live Smoke Execution

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Promote the direct Codex smoke into a durable server-owned live smoke lane.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/082-task-backed-live-workflow-closeout.md`

## Goals

- [x] Add a durable live-smoke request and authority boundary.
- [x] Route the smoke through durable dispatch and invocation records.
- [x] Persist sanitized live smoke outcome evidence.
- [x] Compare durable live smoke evidence against the replay fixture.
- [x] Keep real provider writes stopped by default.

## Execution Plan

- [x] Live-smoke boundary batch.
- [x] Dispatch/invocation runner batch.
- [x] Evidence persistence batch.
- [x] Replay comparison diagnostics batch.
- [x] Validation closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/379-durable-codex-live-smoke-boundary.md`
- `batch-cards/380-durable-codex-live-smoke-dispatch-runner.md`
- `batch-cards/381-durable-codex-live-smoke-evidence-persistence.md`
- `batch-cards/382-durable-codex-live-smoke-replay-comparison.md`
- `batch-cards/383-durable-codex-live-smoke-validation-closeout.md`

## Acceptance Criteria

- [x] Default dry-run performs no provider write.
- [x] Real provider write requires explicit confirmation and effect flag.
- [x] Durable dispatch/invocation/outcome records are used as the authority path.
- [x] Persisted evidence remains sanitized and replayable.
- [x] Task, review, callback, cancellation, resume, and SCM authority remain
      separate.
