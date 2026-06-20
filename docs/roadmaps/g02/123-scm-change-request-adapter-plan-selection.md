# 123 SCM Change Request Adapter Plan Selection

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Select adapter-specific change-request preparation plans from persisted
adapter-neutral preparation admissions without executing SCM or forge effects.

This lane maps preparation intent to provider-specific plan records. It is not
branch creation, snapshot publication, commit creation, push, PR creation,
merge, provider write, callback response, interruption, recovery, or raw-output
retention.

Resumed after the 2026-06-20 health/runway rebaseline reduced the active-lane
god-file pressure. Remaining doctor errors are broader durable/Codex/provider
health debt tracked in the implementation gap index.

## Governing Refs

- `docs/roadmaps/g02/121-scm-capture-change-request-preparation-admission.md`
- `docs/roadmaps/g02/122-scm-capture-change-request-preparation-control.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define adapter plan records for Git-like and convergence-like workflows.
- [x] Preserve provider-neutral preparation refs.
- [x] Keep commit/snapshot/publish terminology adapter-scoped.
- [x] Keep all execution authority absent.
- [ ] Choose the first executable adapter lane from evidence.

## Execution Plan

- [x] Adapter plan record batch.
- [x] Git-like plan mapping batch.
- [x] Convergence-like plan mapping batch.
- [x] Adapter plan diagnostics batch.
- [ ] Authority and closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/583-scm-change-request-adapter-plan-closeout.md`

Planned cards:

None.

Completed cards:

- `batch-cards/579-scm-change-request-adapter-plan-records.md`
- `batch-cards/580-scm-change-request-git-like-plan.md`
- `batch-cards/581-scm-change-request-convergence-like-plan.md`
- `batch-cards/582-scm-change-request-adapter-plan-diagnostics.md`

## Acceptance Criteria

- [x] Adapter plans preserve preparation admission refs.
- [x] Git-like workflows use commit/branch/push terms only inside Git-like plan
  records.
- [x] Convergence-like workflows use snapshot/publish terms only inside
  convergence-like plan records.
- [x] Unsupported adapter labels produce visible blockers.
- [x] No SCM, forge, provider, callback, interruption, recovery, or raw-output
  authority is granted.
