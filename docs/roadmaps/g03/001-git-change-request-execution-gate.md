# 001 Git Change Request Execution Gate

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Admit Git change-request execution intent from Git-like adapter plans without
running branch, commit, push, or pull-request effects.

This milestone creates the records that later runners must pass through before
touching a repository or forge.

## Governing Refs

- `docs/roadmaps/g02/123-scm-change-request-adapter-plan-selection.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/003-project-identity-contract.md`

## Goals

- [x] Model branch, commit, push, and pull-request authority separately.
- [x] Preserve adapter-plan, preparation, task, repo, operator, workflow, and
  evidence refs.
- [x] Keep command descriptors separate from execution requests.
- [x] Keep all Git and forge effects stopped-by-default.
- [x] Route diagnostics without granting authority.

## Execution Plan

- [x] Git execution authority records batch.
- [x] Git command descriptor batch.
- [x] Git command request batch.
- [x] Git preflight records batch.
- [x] Git diagnostics batch.
- [x] Authority and closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/001-git-change-request-execution-authority-records.md`
- `batch-cards/002-git-change-request-command-descriptors.md`
- `batch-cards/003-git-change-request-command-request-records.md`
- `batch-cards/004-git-change-request-preflight-records.md`
- `batch-cards/005-git-change-request-diagnostics.md`
- `batch-cards/006-git-change-request-authority-closeout.md`

## Closeout

The first g03 lane completed as records only. Git change-request execution now
has authority records, data-only command descriptors, stopped-by-default
request records, preflight records, and read-only diagnostics. The next lane is
the Git change-request dry-run runner, still stopped before branch, commit,
push, or pull-request effects.

## Acceptance Criteria

- [x] Git authority records distinguish branch, commit, push, and PR gates.
- [x] Non-ready Git plans are visible blockers.
- [x] Convergence-like and unsupported adapter plans are rejected.
- [x] No branch, commit, push, pull-request, forge, provider, callback,
  interruption, recovery, or raw-output effect is executed.
