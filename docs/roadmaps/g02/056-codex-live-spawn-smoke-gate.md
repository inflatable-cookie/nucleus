# 056 Codex Live Spawn Smoke Gate

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Prove the smallest live Codex app-server process path.

Roadmap `055` prepared process and transport acceptance records without
spawning. This lane should add a constrained smoke path that can start an owned
Codex process only after explicit readiness/admission, capture bounded startup
evidence, and stop cleanly.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a constrained Codex process spawn smoke request.
- [x] Require accepted spawn intent and local process-control readiness.
- [x] Capture bounded startup stdout/stderr metadata without raw stream
      retention by default.
- [ ] Stop the process cleanly in the smoke path.
- [x] Surface accepted, blocked, failed, timed-out, and cleanup-required smoke
      receipts.

## Non-Goals

- Do not send turns.
- Do not answer callbacks.
- Do not implement cancellation beyond smoke cleanup.
- Do not implement resume/recovery.
- Do not mutate tasks from provider events.
- Do not add UI panels.

## Execution Plan

- [x] Smoke request batch: add constrained live spawn smoke request records.
- [x] Runner batch: wire the request to existing local process-control/read-only
      spawn primitives where safe.
- [x] Evidence batch: capture bounded startup evidence and cleanup outcomes.
- [x] Diagnostics batch: expose smoke results through read-only diagnostics.
- [ ] Closeout batch: validate and select turn-start, callback, cancellation,
      recovery, or subscription as the next gate.

## Batch Cards

Ready cards:

- `batch-cards/250-codex-live-spawn-smoke-closeout.md`

Planned cards:

- None.

Completed cards:

- `batch-cards/246-codex-live-spawn-smoke-request.md`
- `batch-cards/247-codex-live-spawn-smoke-runner.md`
- `batch-cards/248-codex-live-spawn-smoke-evidence.md`
- `batch-cards/249-codex-live-spawn-smoke-diagnostics.md`

## Acceptance Criteria

- [x] Smoke spawn cannot run without accepted spawn intent.
- [x] Smoke path has bounded output and timeout policy.
- [x] Cleanup outcome is explicit.
- [x] Receipts are sanitized and replay-safe.
- [ ] Validation passes.

## Gate

Do not send provider turns or answer callbacks until live spawn startup and
cleanup are proven.
