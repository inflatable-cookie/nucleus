# 055 Codex Process And Transport Acceptance

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Prepare the first Codex app-server process and stdio transport acceptance
path.

Roadmap `054` proved durable observation acceptance after a frame is decoded.
This lane should define and implement the narrow boundary before decoded frames
exist: process intent, owned runtime identity, stdio framing posture, startup
readiness, and failure receipts.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define Codex owned-runtime instance records.
- [x] Define stdio transport frame source and decode-failure records.
- [x] Gate process spawn intent through host authority, binary, auth, schema,
      transport, process-control, and payload-retention readiness.
- [x] Link startup, handshake, decode, and process-exit failures to sanitized
      runtime receipts.
- [ ] Keep provider callbacks, cancellation, resume, and task mutation out of
      scope.

## Non-Goals

- Do not answer Codex approval or user-input callbacks.
- Do not implement provider-reaching cancellation.
- Do not implement provider resume/recovery execution.
- Do not add desktop panels.
- Do not widen SCM or forge behavior.

## Execution Plan

- [x] Runtime instance batch: add Codex process/runtime instance records.
- [x] Transport batch: add stdio frame source and decode outcome records.
- [x] Startup gate batch: compose readiness into spawn-intent admission records.
- [x] Receipt batch: map startup/decode/exit failures to runtime receipts.
- [ ] Closeout batch: validate and select callback, cancellation, recovery, or
      subscription as the next gate.

## Batch Cards

Ready cards:

- `batch-cards/245-codex-process-transport-closeout.md`

Planned cards:

- None.

Completed cards:

- `batch-cards/241-codex-runtime-instance-records.md`
- `batch-cards/242-codex-stdio-frame-source-records.md`
- `batch-cards/243-codex-spawn-intent-admission.md`
- `batch-cards/244-codex-startup-and-decode-receipts.md`

## Acceptance Criteria

- [x] Runtime instance records preserve host, adapter, process, session, and
      payload-retention authority without spawning by themselves.
- [x] Transport source records can describe decoded, malformed, unsupported,
      and recovery-required frames.
- [x] Spawn intent is blocked unless host/process/auth/schema/transport gates
      are ready.
- [x] Startup and decode failure receipts are sanitized and replay-safe.
- [ ] Validation passes.

## Gate

Do not implement callback responses, cancellation, resume execution, or task
state mutation until process and transport acceptance is explicit and tested.
