# 049 Doctor-Green Health Closeout And Next Lane Selection

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Record the health reset now that `effigy doctor` has no hard errors, triage the
remaining warning pressure without turning it into churn, and choose the next
bounded implementation lane from current architecture evidence.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/roadmaps/g03/README.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Capture the doctor-green evidence and the scope of the split batch.
- [ ] Separate remaining warning pressure from implementation blockers.
- [ ] Select the next implementation lane from product value and architecture
  readiness, not from cleanup momentum.

## Execution Plan

- [x] Health evidence closeout.
- [ ] God-file warning pressure triage.
- [ ] Next implementation lane selection.

## Batch Cards

Ready cards:

- `batch-cards/161-god-file-warning-pressure-triage.md`

Planned cards:

- `batch-cards/162-next-implementation-lane-selection.md`

Completed cards:

- `batch-cards/160-doctor-green-health-evidence-closeout.md`

## Acceptance Criteria

- [x] `effigy doctor` stays error-free or any regression is recorded as a
  blocker.
- [x] Health docs name zero doctor errors and remaining warnings clearly.
- [ ] The next lane is bounded enough to execute without drifting back into
  broad cleanup.
- [ ] No provider write, SCM mutation, process spawn, UI expansion, remote
  transport, callback response, interruption, recovery, or task mutation
  authority is added by the closeout itself.
