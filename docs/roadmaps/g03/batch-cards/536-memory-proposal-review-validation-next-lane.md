# 536 Memory Proposal Review Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../122-memory-proposal-review-command-foundation.md`

## Purpose

Validate the memory proposal review command foundation and choose the next
lane.

## Work

- [x] Run focused memory/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Reassess whether to move next to desktop review controls, planning
  import apply/review, research execution planning, or accepted memory
  authority.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] The next lane follows evidence and does not create accepted memory or
  projection authority by accident.

## Evidence

- `effigy server:query:memory-proposal-review-diagnostics` passed.
- `cargo check -p nucleus-server -p nucleusd -p nucleus-desktop` passed.
- `cargo test -p nucleus-server memory_proposal_review -- --nocapture` passed.
- `cargo test -p nucleusd memory_proposal -- --nocapture` passed.
- `effigy qa:docs` passed.
- `effigy qa:northstar` passed.
- `git diff --check` passed.
- `effigy doctor` passed with warning-only god-file findings.

## Decision

Selected next lane:

- `../123-planning-projection-import-review-apply.md`

Reason:

- accepted memory mutation remains too broad without accepted-memory storage,
  projection, retention, ranking, and privacy policy
- research execution planning still needs retrieval/source policy
- desktop review controls would add UI churn before planning apply/review is
  proven
- planning projection import has stopped candidates, admissions, conflicts,
  diagnostics, and an app-native planning domain ready for a controlled
  review/apply lane

Deferred:

- accepted memory authority
- final memory review UI
- research execution, browser automation, crawler/source retrieval, and model
  orchestration
- automatic task creation or promotion from imported planning projections
