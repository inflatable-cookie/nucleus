# 090 Live Evidence Completion Control Read Model

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose explicit live evidence completion projections through server read models
and control diagnostics without granting clients task mutation authority.

## Governing Refs

- `docs/roadmaps/g02/089-live-evidence-completion-projection.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Compose persisted completions, timeline projection, progress projection,
      and diagnostics into a read-model record.
- [x] Add query-ready DTOs for completion projection state.
- [x] Keep raw provider material, provider writes, SCM, callback,
      interruption, and recovery authority closed.
- [x] Preserve deterministic ordering and repair states.
- [x] Select the next lane from validated evidence.

## Execution Plan

- [x] Completion read-model composition batch.
- [x] Control DTO shape batch.
- [x] Diagnostics domain routing readiness batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/414-live-evidence-completion-read-model-composition.md`
- `batch-cards/415-live-evidence-completion-control-dto.md`
- `batch-cards/416-live-evidence-completion-diagnostics-routing-readiness.md`
- `batch-cards/417-live-evidence-completion-control-authority-regressions.md`
- `batch-cards/418-live-evidence-completion-control-read-model-closeout.md`

## Acceptance Criteria

- [x] Server read model composes completion timeline/progress/diagnostics.
- [x] DTO records are sanitized and deterministic.
- [x] Diagnostics routing can name the completion projection domain.
- [x] Clients receive no mutation/provider/SCM authority.
- [x] The next lane is selected from evidence after validation.
