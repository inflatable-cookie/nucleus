# 049 Doctor-Green Health Closeout And Next Lane Selection

Status: completed
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
- [x] Separate remaining warning pressure from implementation blockers.
- [x] Select the next implementation lane from product value and architecture
  readiness, not from cleanup momentum.

## Execution Plan

- [x] Health evidence closeout.
- [x] God-file warning pressure triage.
- [x] Next implementation lane selection.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/160-doctor-green-health-evidence-closeout.md`
- `batch-cards/161-god-file-warning-pressure-triage.md`
- `batch-cards/162-next-implementation-lane-selection.md`

## Acceptance Criteria

- [x] `effigy doctor` stays error-free or any regression is recorded as a
  blocker.
- [x] Health docs name zero doctor errors and remaining warnings clearly.
- [x] The next lane is bounded enough to execute without drifting back into
  broad cleanup.
- [x] No provider write, SCM mutation, process spawn, UI expansion, remote
  transport, callback response, interruption, recovery, or task mutation
  authority is added by the closeout itself.

## Closeout

Warning pressure is touch-when-needed structural debt, not a blocker. The next
lane is explicit Git branch/worktree runner proof because it is the narrowest
high-value SCM step after the represented g03 handoff chain. It stays limited
to branch/worktree setup and does not widen commit, push, PR, forge, provider,
callback, interruption, recovery, task mutation, UI, or remote transport
authority.
