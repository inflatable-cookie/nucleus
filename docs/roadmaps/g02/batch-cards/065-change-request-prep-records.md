# 065 Change Request Prep Records

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../017-scm-working-copy-and-change-request-workflows.md`

## Purpose

Prepare neutral change-request handoff records before forge-specific
publication.

## Scope

- Add change-request preparation records.
- Link task work item, SCM change session, checkpoint/diff evidence, and
  intended target.
- Keep forge publication, PR creation, and merge out of scope.
- Preserve non-Git SCM vocabulary.

## Acceptance Criteria

- [x] Change-request prep is distinct from publication.
- [x] GitHub/GitLab-style PRs are possible targets but not the storage model.
- [x] Convergence-style publication remains viable.

## Outcome

Added `nucleus-engine::change_request_prep` as an engine-owned,
pre-publication handoff surface.

Prep records link task work items, SCM work sessions, provider-neutral change
refs, checkpoint ids, diff summary ids, runtime receipt ids, target shape,
review policy, prep status, and publication state.

Targets can describe forge review, provider publication, provider gate, direct
authority update, manual handoff, or custom provider value. Publication starts
as not requested. The implementation does not create pull requests, publish,
merge, push, promote, resolve credentials, or call remote APIs.

## Validation

- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if publication credentials or remote forge APIs are needed.
