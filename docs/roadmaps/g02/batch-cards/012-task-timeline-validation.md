# 012 Task Timeline Validation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Validate and close the task timeline projection milestone.

## Scope

- Focused timeline projection tests.
- Focused server query tests.
- Workspace compile.
- Northstar docs checks.
- Milestone closeout and next pointer.

## Out Of Scope

- Full workspace UI tests.
- Provider harness tests.
- SCM/checkpoint implementation.

## Promotion Targets

- `docs/roadmaps/g02/004-task-timeline-and-history-projection.md`
- `docs/roadmaps/README.md`

## Acceptance Criteria

- [x] `cargo check --workspace` passes.
- [x] Focused timeline/server tests pass.
- [x] `effigy qa:docs` passes.
- [x] `effigy qa:northstar` passes.
- [x] The next lane remains `g02/005-runtime-receipts-and-effect-reactors.md`
  unless validation exposes a contract gap.

## Stop Conditions

- Timeline projection reveals missing identity rules in
  `019-conversation-timeline-contract.md`.

## Outcome

Validated the task timeline tranche with focused engine/server tests,
workspace compile, Northstar docs checks, and diff hygiene.
