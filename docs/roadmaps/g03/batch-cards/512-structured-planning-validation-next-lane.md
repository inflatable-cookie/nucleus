# 512 Structured Planning Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Validate the structured planning foundation and choose the next lane.

## Work

- [x] Run focused planning crate/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Reassess whether the next lane is planning session persistence depth,
  planning-memory proposals, deep research run briefs, import apply/review, or
  a disposable planning UI proof.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] Next lane follows evidence and does not reopen deferred effects by
  accident.

## Evidence

- `cargo fmt --check` passed.
- `cargo test -p nucleus-planning` passed.
- `cargo test -p nucleus-server planning_sessions` passed.
- `cargo test -p nucleusd planning_sessions` passed.
- `cargo check --workspace` passed.
- `effigy server:query:planning-sessions` passed.
- `effigy qa:docs` passed.
- `effigy qa:northstar` passed.
- `git diff --check` passed.
- `effigy doctor` passed with warning-only god-file findings.

## Next Lane Decision

Selected next lane:

- `../119-planning-memory-proposal-foundation.md`

Reason:

- active import apply still needs more app-native planning target depth and
  merge policy before it is useful
- deep research is larger and should produce memory proposals and planning
  refs rather than stand alone first
- a disposable planning UI proof would risk churn before planning-memory
  review semantics exist
- memory proposal records are the smallest useful bridge from planning
  sessions, exploration, research, and agent conversations into durable
  project context

Deferred:

- active projection/import apply
- deep research run execution
- memory embeddings and semantic search
- final memory review UI
- autonomous memory extraction policy
- task promotion or creation from memory proposals
