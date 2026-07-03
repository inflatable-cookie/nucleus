# 507 Planning Session Record Types

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../118-structured-planning-domain-foundation.md`

## Purpose

Model guided planning sessions as durable value records.

## Work

- [x] Add planning session id, kind, status, participant refs, source refs,
  artifact refs, task seed refs, memory refs, and timestamps where scoped.
- [x] Keep session records independent of harness transcript storage.
- [x] Add focused unit tests for stable identity and status vocabulary.

## Acceptance Criteria

- [x] Session records can represent project intake, vision definition,
  ideation, architecture planning, research planning, roadmap planning, and
  task breakdown.
- [x] Session records do not imply agent scheduling or model execution.
- [x] Raw transcript authority remains out of scope.

## Evidence

- Added `PlanningSessionId` and first planning-domain id refs.
- Added `PlanningSession`, session kind/status, participant refs, source refs,
  output refs, and timestamps.
- Added focused tests for contract kind coverage, stable identity, and
  transcript refs as source material only.
- `cargo test -p nucleus-planning` passed.
- `cargo check --workspace` passed.
