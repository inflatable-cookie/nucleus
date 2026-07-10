# 082 Selected Task Delegation Control Surfaces

Status: superseded
Owner: Tom
Updated: 2026-07-07
Milestone: `../017-selected-task-delegation-scheduling-admission.md`

## Purpose

Expose selected-task delegation scheduling admission through read-only control,
CLI, and Effigy surfaces.

## Work

- [ ] Add server query/control DTOs for delegation scheduling admission.
- [ ] Add `nucleusd query` rendering.
- [ ] Add an Effigy selector for the same query.
- [ ] Add request/response DTO and CLI rendering tests.

## Acceptance Criteria

- [ ] CLI and Effigy output show status, refusal, source refs, candidate
  work-item refs, operator/idempotency/revision guards, and no-effect flags.
- [ ] Serialized control envelopes do not expose raw provider payloads.
- [ ] The query cannot start providers, mutate SCM/forge, or publish
  projections.

## Superseded By

`138-conversation-mandate-turn-start-boundary.md` through
`142-task-workflow-portal-receipts-and-live-validation.md`.
