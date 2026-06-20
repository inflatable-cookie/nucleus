# 119 SCM Capture Review Decision Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist explicit operator review decisions over SCM capture review readiness
records before any change-request preparation, SCM mutation, or forge lane.

This lane records operator intent only. It is still not a checkout, worktree,
branch, commit, push, PR, merge, provider, callback, interruption, recovery, or
raw-output lane.

## Governing Refs

- `docs/roadmaps/g02/117-scm-capture-operator-review-readiness.md`
- `docs/roadmaps/g02/118-scm-capture-review-control-integration.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define operator review decision records over review readiness refs.
- [x] Support accepted, rejected, needs-changes, and abandoned decisions.
- [x] Persist decisions with duplicate and blocked-state handling.
- [x] Summarize persisted decisions through diagnostics.
- [x] Keep change-request, SCM, forge, provider, callback, interruption,
  recovery, and raw-output authority absent.

## Execution Plan

- [x] Review decision record batch.
- [x] Review decision persistence batch.
- [x] Duplicate and blocked-state regression batch.
- [x] Review decision diagnostics batch.
- [x] Authority and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/559-scm-capture-review-decision-records.md`
- `batch-cards/560-scm-capture-review-decision-persistence.md`
- `batch-cards/561-scm-capture-review-decision-duplicate-blocked.md`
- `batch-cards/562-scm-capture-review-decision-diagnostics.md`
- `batch-cards/563-scm-capture-review-decision-authority-closeout.md`

## Acceptance Criteria

- [x] Operator review decisions reference readiness records by id.
- [x] Accepted, rejected, needs-changes, and abandoned decisions are explicit.
- [x] Duplicate decision ids are blocked.
- [x] Blocked readiness cannot be accepted silently.
- [x] Decision diagnostics expose counts without raw output or mutation
  authority.
