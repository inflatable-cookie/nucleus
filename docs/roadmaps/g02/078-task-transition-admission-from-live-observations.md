# 078 Task Transition Admission From Live Observations

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Admit task work-item runtime transitions from live provider observations without
letting provider status mutate task state directly.

## Governing Refs

- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/077-codex-runtime-observation-event-store-linkage.md`

## Goals

- [x] Derive work-item transition candidates from live observations.
- [x] Gate runtime transitions through engine admission records.
- [x] Project task timeline entries from accepted transitions.
- [x] Gate review readiness separately from runtime completion.
- [x] Keep task completion and review acceptance blocked.

## Execution Plan

- [x] Candidate batch: map observations to work-item transition candidates.
- [x] Admission batch: validate runtime transitions.
- [x] Timeline batch: project accepted live-observation transitions.
- [x] Review batch: derive review readiness, not acceptance.
- [x] Closeout batch: validate and activate wait/callback persistence.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/354-live-observation-work-item-candidates.md`
- `batch-cards/355-work-item-runtime-transition-admission.md`
- `batch-cards/356-live-observation-task-timeline-projection.md`
- `batch-cards/357-review-readiness-from-live-observations.md`
- `batch-cards/358-task-transition-admission-validation-closeout.md`

## Acceptance Criteria

- [x] Provider completion can only create completed runtime state.
- [x] Review readiness requires explicit evidence.
- [x] Task completion remains a separate admitted command.
- [x] Validation passes or blockers are recorded.
