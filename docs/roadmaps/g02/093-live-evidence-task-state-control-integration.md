# 093 Live Evidence Task State Control Integration

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose live evidence task-state transition admission and task-history projection
through explicit server control surfaces.

## Governing Refs

- `docs/roadmaps/g02/092-live-evidence-completion-task-state-transition.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define control command/query vocabulary for task-state transition
      admission.
- [x] Compose transition admission from completion diagnostics state.
- [x] Expose task-history projection through read-only control results.
- [x] Keep provider, callback, interruption, recovery, SCM, and raw material
      authority closed.
- [x] Select the next lane from validated evidence.

## Execution Plan

- [x] Control vocabulary batch.
- [x] Handler admission composition batch.
- [x] History projection response batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/429-live-evidence-task-state-control-vocabulary.md`
- `batch-cards/430-live-evidence-task-state-handler-admission.md`
- `batch-cards/431-live-evidence-task-state-history-response.md`
- `batch-cards/432-live-evidence-task-state-control-authority-regressions.md`
- `batch-cards/433-live-evidence-task-state-control-closeout.md`

## Acceptance Criteria

- [x] Control vocabulary can name explicit task-state transition admission.
- [x] Handler composition remains explicit and evidence-backed.
- [x] History projection responses are sanitized.
- [x] No provider/SCM/callback/recovery authority is granted.
- [x] The next lane is selected from evidence after validation.
