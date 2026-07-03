# 511 Planning Session Query CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Expose read-only inspection for planning sessions if storage is ready.

## Work

- [x] Add a server query shape for planning sessions or diagnostics.
- [x] Add control DTO support.
- [x] Add `nucleusd query` rendering.
- [x] Add an Effigy selector.
- [x] Add focused tests.

## Acceptance Criteria

- [x] The query reports sanitized planning session counts and refs.
- [x] Raw transcript, provider payload, private memory, and secret material are
  not exposed.
- [x] No provider, task, SCM, forge, memory embedding, deep research, or UI
  effects are added.

## Evidence

- Added `PlanningSessionsQuery` and sanitized
  `PlanningSessionsProjection`.
- Added a read-only request-handler query over the existing planning local-store
  domain.
- Added local bootstrap seeding for one planning session record.
- Added control request/response DTO support.
- Added `nucleusd query planning-sessions --project <project-id>` rendering.
- Added Effigy selector `server:query:planning-sessions`.
- Focused server, DTO, CLI parser, renderer, and selector checks passed.
