# 004 Event Store Hardening Validation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Validate the event-store hardening tranche and close the milestone.

## Scope

- Run focused Rust checks for orchestration, server request handling, and
  workspace compile.
- Run Northstar docs checks.
- Update milestone outcome.
- Update the roadmap front door with the next lane.

## Out Of Scope

- Large speculative suites.
- Release configuration.
- UI redesign.

## Promotion Targets

- `docs/roadmaps/g02/002-event-store-persistence-hardening.md`
- `docs/roadmaps/README.md`

## Acceptance Criteria

- [x] `cargo check --workspace` passes.
- [x] Focused Rust tests for orchestration/server persistence pass.
- [x] `effigy qa:docs` passes.
- [x] `effigy qa:northstar` passes.
- [x] The milestone outcome states what changed and what remains next.

## Stop Conditions

- Validation exposes a contract gap that changes the event-store model.

## Outcome

Validated the event-store hardening tranche with workspace compile, focused
orchestration/server tests, Northstar docs checks, and diff hygiene.
