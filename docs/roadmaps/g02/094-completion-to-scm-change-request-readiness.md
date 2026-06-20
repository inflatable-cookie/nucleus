# 094 Completion To SCM Change Request Readiness

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Prepare the path from completed task-state evidence to SCM capture and
change-request readiness without executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/093-live-evidence-task-state-control-integration.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define completion-to-SCM promotion candidates from task-state history.
- [x] Preserve provider-neutral SCM vocabulary.
- [x] Keep Git and non-Git SCM semantics separate.
- [x] Keep SCM capture/share/change-request effects gated.
- [x] Select the next lane from validated evidence.

## Execution Plan

- [x] Promotion candidate records batch.
- [x] Provider-neutral SCM mapping batch.
- [x] Change-request readiness diagnostics batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/434-completion-scm-promotion-candidates.md`
- `batch-cards/435-completion-scm-provider-neutral-mapping.md`
- `batch-cards/436-completion-change-request-readiness-diagnostics.md`
- `batch-cards/437-completion-scm-authority-regressions.md`
- `batch-cards/438-completion-scm-readiness-closeout.md`

## Acceptance Criteria

- [x] Completed task-state history can produce SCM promotion candidates.
- [x] Git-specific and non-Git-specific terms stay outside core records.
- [x] Change-request readiness remains diagnostic only.
- [x] No SCM or forge effects execute.
- [x] The next lane is selected from evidence after validation.

## Closeout

Completion-to-SCM readiness now has provider-neutral candidate, mapping,
diagnostic, and authority records. Core records preserve task/work/completion
refs and adapter/workflow labels without assuming Git commits, branches, or
worktrees.

Next lane: expose these records through read-only control diagnostics before
any SCM capture, publish, review request, or forge operation can execute.
