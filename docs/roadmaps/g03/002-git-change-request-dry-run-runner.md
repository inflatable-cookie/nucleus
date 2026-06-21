# 002 Git Change Request Dry-Run Runner

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Model Git change-request dry-run runner handoff from passed preflight records
without creating branches, commits, pushes, or pull requests.

This lane may describe dry-run handoff and sanitized outcome records. It must
not execute Git mutation or forge effects.

## Governing Refs

- `docs/roadmaps/g03/001-git-change-request-execution-gate.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/003-project-identity-contract.md`

## Goals

- [x] Admit runner handoff only from ready preflight records.
- [x] Retain request, descriptor, authority, plan, task, repo, and evidence
  refs.
- [x] Record sanitized dry-run outcomes without raw command output.
- [x] Compose evidence records for review without Git mutation.
- [x] Route diagnostics without granting authority.

## Execution Plan

- [x] Dry-run handoff batch.
- [x] Sanitized outcome batch.
- [x] Evidence composition batch.
- [x] Diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/007-git-change-request-dry-run-handoff.md`
- `batch-cards/008-git-change-request-dry-run-sanitized-outcomes.md`
- `batch-cards/009-git-change-request-dry-run-evidence.md`
- `batch-cards/010-git-change-request-dry-run-diagnostics.md`
- `batch-cards/011-git-change-request-dry-run-closeout.md`

## Closeout

Git change-request dry-run runner records are complete as non-executing
records. Handoffs admit only ready preflights, sanitized outcomes retain
counts only, evidence records are reviewable by reference, and diagnostics
grant no Git, forge, provider, callback, interruption, recovery, or raw-output
authority.

The next lane is branch/worktree admission, still stopped before actual
checkout or worktree creation.

## Acceptance Criteria

- [x] Handoff records only admit ready preflights.
- [x] Sanitized outcomes retain counts and evidence refs only.
- [x] Evidence records do not contain raw command output.
- [x] No branch, commit, push, pull-request, forge, provider, callback,
  interruption, recovery, or raw-output effect is executed.
