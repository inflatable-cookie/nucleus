# 032 Codex Task Runtime Admission Bridge

Status: planned
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
- `docs/roadmaps/g02/014-codex-live-runtime-supervision.md`

## Goals

- [ ] Create Codex runtime admission records scoped to task work units.
- [ ] Bind scheduler admission to task, adapter, command, and event refs.
- [ ] Preserve wait-state, approval, cancellation, and recovery gates.
- [ ] Avoid launching provider processes until the gate is explicit.

## Execution Plan

- [ ] Runtime request batch: model task-scoped Codex runtime requests.
- [ ] Scheduler batch: bind task work units to scheduler admission.
- [ ] Wait-state batch: connect approval/user-input waits to task work units.
- [ ] Recovery batch: define cancellation and resume blockers.
- [ ] Validation batch: prove admission is not execution.

## Batch Cards

Planned cards:

- `batch-cards/139-codex-task-runtime-request-records.md`
- `batch-cards/140-task-runtime-scheduler-admission.md`
- `batch-cards/141-codex-wait-state-task-linkage.md`
- `batch-cards/142-codex-task-runtime-recovery-gates.md`
- `batch-cards/143-codex-task-runtime-admission-validation.md`

## Acceptance Criteria

- [ ] Task work units can request Codex runtime admission.
- [ ] Scheduler admission has all authority and provenance refs.
- [ ] No provider process starts from this milestone.

## Gate

Stop if Codex runtime execution requires new provider auth or process policy.
