# 078 Task Transition Admission From Live Observations

Status: planned
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

- [ ] Derive work-item transition candidates from live observations.
- [ ] Gate runtime transitions through engine admission records.
- [ ] Project task timeline entries from accepted transitions.
- [ ] Gate review readiness separately from runtime completion.
- [ ] Keep task completion and review acceptance blocked.

## Execution Plan

- [ ] Candidate batch: map observations to work-item transition candidates.
- [ ] Admission batch: validate runtime transitions.
- [ ] Timeline batch: project accepted live-observation transitions.
- [ ] Review batch: derive review readiness, not acceptance.
- [ ] Closeout batch: validate and activate wait/callback persistence.

## Batch Cards

Ready cards:

None.

Planned cards:

- `batch-cards/354-live-observation-work-item-candidates.md`
- `batch-cards/355-work-item-runtime-transition-admission.md`
- `batch-cards/356-live-observation-task-timeline-projection.md`
- `batch-cards/357-review-readiness-from-live-observations.md`
- `batch-cards/358-task-transition-admission-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Provider completion can only create completed runtime state.
- [ ] Review readiness requires explicit evidence.
- [ ] Task completion remains a separate admitted command.
- [ ] Validation passes or blockers are recorded.
