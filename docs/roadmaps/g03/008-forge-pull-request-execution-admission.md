# 008 Forge Pull-Request Execution Admission

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Admit forge pull-request creation intent from reviewable dry-run evidence
without creating pull requests.

## Governing Refs

- `docs/roadmaps/g03/007-forge-pull-request-descriptor-dry-run.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/003-project-identity-contract.md`

## Goals

- [x] Admit PR creation intent only from reviewable PR dry-run evidence.
- [x] Preserve PR descriptor, push, commit, branch/worktree setup, dry-run,
  request, authority, plan, task, repo, and operator refs.
- [x] Keep operator approval explicit.
- [x] Keep pull-request creation, forge/provider effects, callback,
  interruption, recovery, task mutation, and raw-output effects false.
- [x] Route diagnostics without granting authority.

## Execution Plan

- [x] PR execution admission records batch.
- [x] PR execution preflight batch.
- [x] PR execution diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/036-forge-pull-request-execution-admission-records.md`
- `batch-cards/037-forge-pull-request-execution-preflight.md`
- `batch-cards/038-forge-pull-request-execution-diagnostics.md`
- `batch-cards/039-forge-pull-request-execution-closeout.md`

## Acceptance Criteria

- [x] PR execution admission records require reviewable PR dry-run evidence.
- [x] Operator approval is explicit.
- [x] Non-reviewable PR evidence is blocked.
- [x] No pull-request, forge, provider, callback, interruption, recovery, task
  mutation, or raw-output effect is executed.

## Closeout

PR execution authority is represented as stopped-by-default admission and
preflight records. G03 can now close the Git change-request chain before
choosing the next adapter lane.
