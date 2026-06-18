# 032 Codex Task Runtime Admission Bridge

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Bridge task-backed work units to the existing Codex runtime supervision path
through admission records, not unattended execution.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/roadmaps/g02/014-codex-live-runtime-supervision.md`

## Goals

- [x] Create Codex runtime admission records scoped to task work units.
- [x] Bind scheduler admission to task, adapter, command, and event refs.
- [x] Preserve wait-state, approval, cancellation, and recovery gates.
- [x] Avoid launching provider processes until the gate is explicit.

## Execution Plan

- [x] Runtime request batch: model task-scoped Codex runtime requests.
- [x] Scheduler batch: bind task work units to scheduler admission.
- [x] Wait-state batch: connect approval/user-input waits to task work units.
- [x] Recovery batch: define cancellation and resume blockers.
- [x] Validation batch: prove admission is not execution.

## Batch Cards

Completed cards:

- `batch-cards/139-codex-task-runtime-request-records.md`
- `batch-cards/140-task-runtime-scheduler-admission.md`
- `batch-cards/141-codex-wait-state-task-linkage.md`
- `batch-cards/142-codex-task-runtime-recovery-gates.md`
- `batch-cards/143-codex-task-runtime-admission-validation.md`

## Acceptance Criteria

- [x] Task work units can request Codex runtime admission.
- [x] Scheduler admission has all authority and provenance refs.
- [x] No provider process starts from this milestone.

## Result

Added `codex_task_runtime` with request records, scheduler admission, wait
linkage, and recovery gates. The bridge remains admission-only.

## Gate

Stop if Codex runtime execution requires new provider auth or process policy.
