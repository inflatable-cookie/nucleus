# 054 Git Forge Runner Health Boundary Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Rebaseline the Git and forge runner proof family before adding real provider
auth, forge network execution, callback, recovery, task mutation, or raw-output
authority.

The lane checks that branch/worktree, commit, push, and stopped pull-request
request preparation still share the same stopped-by-default shape:

- authority records
- constrained adapter records
- sanitized outcome persistence
- read-only diagnostics and control DTOs

It must not add new execution behavior.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/050-git-branch-worktree-runner-proof.md`
- `docs/roadmaps/g03/051-git-commit-runner-proof.md`
- `docs/roadmaps/g03/052-git-push-runner-proof.md`
- `docs/roadmaps/g03/053-forge-pull-request-runner-proof.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Refresh focused evidence for all Git/forge runner proof modules.
- [x] Audit authority boundaries for accidental execution widening.
- [x] Check warning pressure and module shape before adding provider-auth work.
- [x] Select the next lane from evidence, not recent momentum.
- [x] Keep docs and Northstar routing clean.

## Execution Plan

- [x] Runner evidence refresh.
- [x] Boundary and authority audit.
- [x] Warning pressure triage.
- [x] Next lane selection.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/183-git-forge-runner-health-evidence-refresh.md`
- `batch-cards/184-runner-boundary-authority-audit.md`
- `batch-cards/185-runner-warning-pressure-triage.md`
- `batch-cards/186-next-provider-auth-lane-selection.md`
- `batch-cards/187-git-forge-runner-rebaseline-validation-closeout.md`

## Acceptance Criteria

- [x] Focused tests cover branch/worktree, commit, push, and stopped
  pull-request runner proof modules.
- [x] `cargo check -p nucleus-server` passes.
- [x] `effigy doctor` remains error-free.
- [x] God-file findings do not increase from the current warning baseline
  unless a blocker is recorded.
- [x] The implementation gap index records the confirmed boundary state.
- [x] The next roadmap pointer blocks provider-auth and forge network writes
  until their contract lane is compiled.

## Stop Conditions

- Any runner module grants shell passthrough, provider writes, callbacks,
  interruption, recovery, task mutation, or raw-output authority.
- `effigy doctor` reports errors.
- New runner files create fresh warning pressure that should be split before
  widening the lane.

## Closeout

Focused runner tests passed for branch/worktree, commit, push, and stopped PR
request preparation: 48 tests total.

Confirmed boundary state:

- branch/worktree, commit, push, and stopped PR request preparation all keep
  authority, adapter/request adapter, sanitized outcome persistence, and
  read-only control DTOs separated
- shell passthrough and shell execution remain blocked
- forge/provider writes remain blocked
- callbacks, interruption, recovery, task mutation, and raw-output retention
  remain blocked
- new runner proof modules are below the god-file warning threshold

Health:

- `cargo check -p nucleus-server` passes
- `effigy doctor` reports 137 warnings and 0 errors

Next lane:

- compile the provider-auth and forge execution contract lane before adding
  real forge network writes, callbacks, recovery, task mutation, or raw-output
  authority
