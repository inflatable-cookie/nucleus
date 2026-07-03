# 527 Deep Research Run Brief Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Validate the deep research run brief foundation and choose the next lane.

## Work

- [x] Run focused research/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Reassess whether the next lane is accepted memory review commands,
  research execution planning, planning import apply/review, or a disposable
  planning/research UI proof.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] The next lane follows evidence and does not reopen deferred effects by
  accident.

## Evidence

- `cargo check -p nucleus-local-store -p nucleus-server -p nucleusd` passed.
- `cargo test -p nucleus-server research_run_briefs -- --nocapture` passed.
- `cargo test -p nucleusd research_run_briefs -- --nocapture` passed.
- `effigy server:query:research-run-briefs` passed.
- `effigy qa:docs` passed.
- `effigy qa:northstar` passed.
- `git diff --check` passed.
- `effigy doctor` passed with warning-only god-file findings.

## Next Lane Decision

Selected next lane:

- `../121-disposable-planning-research-ui-proof.md`

Reason:

- structured planning, memory proposals, and deep research run briefs now have
  read-only server/CLI inspection
- a thin disposable proof surface can validate whether those read models are
  useful to users before adding review commands or research execution
- accepted memory mutation and planning import apply/review should wait until
  the read-only planning/research surfaces are easier to inspect together
- research execution planning still needs source/retrieval policy, so it should
  not be the next lane

Deferred:

- accepted memory mutation
- planning import apply/review
- research execution, crawling, browser automation, source retrieval, and model
  orchestration
- final UI design
- provider/task/browser/SCM/forge effects
