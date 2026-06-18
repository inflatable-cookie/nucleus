# 035 Desktop Task Agent Progress Proof

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Expose task-backed agent work-unit state in the disposable desktop proof shell.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/roadmaps/g02/026-desktop-diagnostics-proof-surface.md`

## Goals

- [x] Add control query/DTO support for task work-unit progress.
- [x] Add a compact progress panel to the proof shell.
- [x] Show wait states and review state without client authority.
- [x] Keep UI disposable and Svelte/Poodle-based.

## Execution Plan

- [x] DTO batch: add task work-unit progress response shapes.
- [x] Panel batch: render work-unit progress and receipts.
- [x] Wait/review batch: render wait and review states distinctly.
- [x] Validation batch: run desktop and server gates.

## Batch Cards

Completed cards:

- `batch-cards/154-task-work-progress-control-dtos.md`
- `batch-cards/155-desktop-task-work-progress-panel.md`
- `batch-cards/156-desktop-task-work-wait-state-display.md`
- `batch-cards/157-desktop-task-work-review-display.md`
- `batch-cards/158-desktop-task-agent-progress-validation.md`

## Acceptance Criteria

- [x] Desktop can inspect task-agent progress through control DTOs.
- [x] Desktop cannot approve, execute, or mutate runtime state from this proof.
- [x] Loading, empty, unsupported, wait, error, and review states are distinct.

## Gate

Do not start final UI layout or workspace-panel design here.
