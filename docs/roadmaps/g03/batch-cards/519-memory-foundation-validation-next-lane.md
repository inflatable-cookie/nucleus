# 519 Memory Foundation Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Validate the memory proposal foundation and choose the next lane.

## Work

- [x] Run focused memory/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Reassess whether the next lane is deep research run briefs, accepted
  memory review commands, planning import apply/review, or a disposable
  planning/memory UI proof.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] The next lane follows evidence and does not reopen deferred effects by
  accident.

## Decision

Next lane: `../120-deep-research-run-brief-foundation.md`.

Reason:

- memory proposals can now receive research findings as refs
- accepted memory review commands would grant new authority too soon
- planning import apply/review would reopen mutation semantics before research
  output exists
- a visible planning/memory UI proof is premature until research run briefs can
  produce inspectable records

## Evidence

- `cargo test -p nucleus-memory`
- `cargo test -p nucleus-server memory_proposals -- --nocapture`
- `cargo test -p nucleusd memory_proposals -- --nocapture`
- `cargo test -p nucleus-local-store shared_memory -- --nocapture`
- `effigy server:query:memory-proposals`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`
