# 061 Codex Session Recovery Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Define Codex session recovery and resume records after process exit, reconnect,
or server restart.

Roadmap `060` proved provider interruption request, admission, envelope,
receipt, and diagnostics state. This lane should add recovery/resume records
before task-state mutation from runtime observations widens.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add recovery need records for exited, disconnected, or restarted Codex
      runtime sessions.
- [x] Gate resume attempts through authority, provider identity, and payload
      retention policy.
- [x] Map accepted resume attempts to sanitized provider envelopes and
      receipts.
- [x] Expose recovery outcomes through read-only diagnostics.
- [x] Keep task-state mutation out of scope.

## Non-Goals

- Do not infer task completion or failure from recovery state.
- Do not replay raw provider payloads.
- Do not add UI controls.
- Do not implement provider command reactors beyond record/envelope boundaries.

## Execution Plan

- [x] Need batch: add recovery need records.
- [x] Admission batch: gate recovery/resume policy.
- [x] Envelope/receipt batch: map accepted resume attempts safely.
- [x] Diagnostics batch: expose recovery state safely.
- [x] Closeout batch: validate and select task-state mutation as the next gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/271-codex-recovery-need-records.md`
- `batch-cards/272-codex-recovery-admission-policy.md`
- `batch-cards/273-codex-recovery-envelope-receipts.md`
- `batch-cards/274-codex-recovery-diagnostics.md`
- `batch-cards/275-codex-recovery-closeout.md`

## Acceptance Criteria

- [x] Recovery records preserve Nucleus and provider identity.
- [x] Admission blocks unsupported, unauthorized, or unsafe resume attempts.
- [x] Envelope and receipts are sanitized and replay-safe.
- [x] Diagnostics expose no raw provider payloads.
- [x] Validation passes.

## Gate

Recovery/resume state is explicit and tested. Next gate:
`062-provider-runtime-materialisation-gate.md`.
