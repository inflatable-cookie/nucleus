# 063 Provider Command Reactor Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Turn provider service ownership and provider runtime outcome records into a
bounded provider command reactor path.

Roadmap `062` made provider diagnostics, service ownership, instance registry,
and runtime receipt/event linkage explicit. The next risk is command execution
shape: provider commands need a server-owned queue, admission result, dispatch
attempt, and outcome path before task state can react to provider observations.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/t3-code-comparison.md`

## Goals

- [x] Define provider command reactor admission and queue records.
- [x] Persist provider command outcomes as runtime receipts/events before task
      mutation.
- [x] Add a Codex turn-start reactor dry-run path that stops before live send.
- [x] Add a Codex callback-response reactor dry-run path that stops before live
      send.
- [x] Select the first live provider send gate only after reactor state is
      explicit and tested.

## Non-Goals

- Do not send commands to Codex yet.
- Do not mutate task state from provider observations.
- Do not widen raw provider payload retention.
- Do not add desktop panels.
- Do not add remote provider hosts.

## Execution Plan

- [x] Reactor contract batch: define command reactor admission, queue,
      dispatch-attempt, and outcome vocabulary.
- [x] Reactor persistence batch: connect provider command outcomes to existing
      runtime receipt/event persistence surfaces.
- [x] Codex turn-start dry-run batch: route a turn-start envelope through
      reactor records without provider send.
- [x] Codex callback dry-run batch: route callback response envelopes through
      reactor records without provider send.
- [x] Closeout batch: validate and select first live provider send gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/281-provider-command-reactor-records.md`
- `batch-cards/282-provider-command-outcome-persistence.md`
- `batch-cards/283-codex-turn-start-reactor-dry-run.md`
- `batch-cards/284-codex-callback-response-reactor-dry-run.md`
- `batch-cards/285-provider-command-reactor-closeout.md`

## Acceptance Criteria

- [x] Provider commands have explicit reactor admission and queue records.
- [x] Provider command outcomes can be persisted as runtime receipts/events.
- [x] Codex turn-start and callback response paths can pass through the
      reactor without live provider send.
- [x] Task mutation remains blocked.
- [x] Validation passes.

## Gate

Do not implement live provider send until the reactor queue, dispatch attempt,
outcome, receipt, and event surfaces are explicit and tested.

Closeout selected Codex live-send readiness as the next gate. Real provider
write execution remains blocked until live-send preflight and transport write
attempt records are explicit and tested.
