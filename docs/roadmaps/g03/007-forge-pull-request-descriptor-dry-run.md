# 007 Forge Pull-Request Descriptor Dry Run

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Describe forge pull-request intent from push-ready state and compose dry-run
evidence without creating pull requests or granting forge write authority.

## Governing Refs

- `docs/roadmaps/g03/006-git-push-admission.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/003-project-identity-contract.md`

## Goals

- [x] Describe pull-request intent from ready push preflight records.
- [x] Preserve push, commit, branch/worktree setup, dry-run, request,
  authority, plan, task, repo, and operator refs.
- [x] Keep forge provider, base branch, head branch, title source, and body
  source explicit.
- [x] Compose reviewable dry-run evidence without forge writes.
- [x] Route diagnostics without granting authority.

## Execution Plan

- [x] Pull-request descriptor records batch.
- [x] Pull-request dry-run evidence batch.
- [x] Pull-request diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/032-forge-pull-request-descriptor-records.md`
- `batch-cards/033-forge-pull-request-dry-run-evidence.md`
- `batch-cards/034-forge-pull-request-diagnostics.md`
- `batch-cards/035-forge-pull-request-descriptor-closeout.md`

## Acceptance Criteria

- [x] Pull-request descriptors require ready push preflight records.
- [x] Forge provider, base branch, head branch, title source, and body source
  are explicit.
- [x] Non-ready push preflight records are blocked.
- [x] No pull-request, forge, provider, callback, interruption, recovery, task
  mutation, or raw-output effect is executed.

## Closeout

Pull-request intent is now represented as descriptors and dry-run evidence
only. Forge write authority remains separate and must be admitted explicitly.
