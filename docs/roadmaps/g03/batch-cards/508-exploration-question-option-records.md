# 508 Exploration Question Option Records

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Model open-ended exploration state without forcing every conversation into a
task plan.

## Work

- [x] Add exploration session value records.
- [x] Add question backlog, assumption, option, risk, opportunity, constraint,
  and decision-ref value records.
- [x] Add promotion refs for accepted artifacts, research briefs, memory
  proposals, and task seeds.
- [x] Add tests that preserve unresolved questions and multiple options.

## Acceptance Criteria

- [x] Exploration can remain exploratory.
- [x] A next task is suggested only from an accepted pathway.
- [x] Promotion is explicit and reviewable.

## Evidence

- Added `ExplorationSession`, mode/status, question, assumption, option,
  tradeoff, note, and promotion-ref value records.
- Added ids for exploration questions, assumptions, options, notes, decisions,
  goals, and roadmap branches.
- Added tests for unresolved questions without next-task pressure, multiple
  options with tradeoffs, and explicit pathway promotion refs.
- `cargo test -p nucleus-planning` passed.
- `cargo check --workspace` passed.
