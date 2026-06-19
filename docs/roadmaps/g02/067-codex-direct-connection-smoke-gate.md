# 067 Codex Direct Connection Smoke Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Prepare the first direct Codex `turn/start` provider-write smoke without
running it by accident.

The previous lane completed the transport-executor handoff and then hardened
task-backed workflow state. This lane exposes the same stopped-by-default gate
through `nucleusd` so the operator can inspect blocked and confirmed states
before deciding whether to run a real provider write.

## Governing Refs

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/065-codex-turn-start-transport-executor-handoff.md`
- `docs/roadmaps/g02/066-task-backed-workflow-hardening.md`

## Goals

- [x] Add a `nucleusd` command-runner surface for the Codex real-write smoke
      boundary.
- [x] Prove the command stays blocked without explicit confirmation.
- [x] Prove the confirmation flag only reports eligibility and still does not
      execute a provider write.
- [x] Keep raw provider payloads, raw streams, task mutation, callback
      responses, cancellation, and resume out of this smoke gate.
- [x] Decide whether to run the real provider-write smoke in a separately
      confirmed step.

## Non-Goals

- Do not run a live Codex provider write in this lane without a new explicit
  operator confirmation.
- Do not add a general Codex adapter runtime.
- Do not widen callback, cancellation, resume, or task mutation behavior.
- Do not persist raw provider material.
- Do not add UI controls.

## Execution Plan

- [x] CLI gate batch: add the `nucleusd command-runner
      codex-turn-start-real-write-smoke` boundary command and tests.
- [x] Decision batch: review the confirmed output and decide whether the next
      step is real provider execution or more hardening.

## Batch Cards

Ready cards:

None.

Paused cards:

None.

Completed cards:

- `batch-cards/302-codex-direct-smoke-cli-boundary.md`
- `batch-cards/303-codex-direct-real-write-decision.md`

## Acceptance Criteria

- [x] The command reports blocked state by default.
- [x] The command reports eligible state only with `--confirm-real-write`.
- [x] Both modes report `provider_write_executed=false`.
- [x] Tests cover command parsing, boundary status, and command-runner entry.
- [x] The new code is split into focused modules.
- [x] Real provider execution is either explicitly approved or remains blocked.

## Gate

The approved live smoke completed through `turn/start` and `turn/completed`
with sanitized output only. Durable server-owned executor integration remains
the next gate.
