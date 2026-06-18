# 035 Desktop Task Agent Progress Proof

Status: planned
Owner: Tom
Updated: 2026-06-18

## Purpose

Expose task-backed agent work-unit state in the disposable desktop proof shell.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g02/026-desktop-diagnostics-proof-surface.md`

## Goals

- [ ] Add control query/DTO support for task work-unit progress.
- [ ] Add a compact progress panel to the proof shell.
- [ ] Show wait states and review state without client authority.
- [ ] Keep UI disposable and Svelte/Poodle-based.

## Execution Plan

- [ ] DTO batch: add task work-unit progress response shapes.
- [ ] Panel batch: render work-unit progress and receipts.
- [ ] Wait/review batch: render wait and review states distinctly.
- [ ] Validation batch: run desktop and server gates.

## Batch Cards

Planned cards:

- `batch-cards/154-task-work-progress-control-dtos.md`
- `batch-cards/155-desktop-task-work-progress-panel.md`
- `batch-cards/156-desktop-task-work-wait-state-display.md`
- `batch-cards/157-desktop-task-work-review-display.md`
- `batch-cards/158-desktop-task-agent-progress-validation.md`

## Acceptance Criteria

- [ ] Desktop can inspect task-agent progress through control DTOs.
- [ ] Desktop cannot approve, execute, or mutate runtime state from this proof.
- [ ] Loading, empty, unsupported, wait, error, and review states are distinct.

## Gate

Do not start final UI layout or workspace-panel design here.
