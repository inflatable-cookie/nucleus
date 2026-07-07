# 010 Selected Task SCM Handoff Readiness

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Make selected-task SCM handoff readiness visible as a practical product step
after review/next-step presentation.

The review/next lane can identify SCM handoff as a pathway-backed next step,
but it does not explain whether the handoff package is ready, what evidence
backs it, what provider-neutral target shape applies, or which gaps block a
future publication/review request. This lane turns existing SCM work-session,
checkpoint, diff, runtime receipt, and change-request prep refs into a
read-only selected-task handoff view.

## Governing Refs

- `docs/roadmaps/g04/009-selected-task-review-next-step-presentation.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/027-provider-auth-forge-execution-contract.md`

## Goals

- [x] Define the selected-task SCM handoff readiness boundary and source map.
- [x] Compose a read-only server model from existing SCM work-session,
  provider-neutral change, checkpoint, diff, runtime receipt, review, and
  change-request prep refs.
- [x] Expose readiness through server control, `nucleusd`, and Effigy.
- [x] Present handoff readiness, target shape, evidence counts, blockers, and
  next step in the disposable desktop proof.
- [x] Keep branch/worktree creation, commit/snapshot creation, push,
  publication, forge calls, credential resolution, merge, provider execution,
  review acceptance, and task completion out of scope.
- [x] Validate the lane and choose the next product workflow lane from g04
  runway evidence.

## Execution Plan

- [x] Batch 1: SCM handoff readiness boundary and source map.
- [x] Batch 2: server read model and no-effect proof.
- [x] Batch 3: CLI/Effigy inspection.
- [x] Batch 4: disposable desktop proof consumption.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/045-selected-task-scm-handoff-boundary.md`
- `batch-cards/046-selected-task-scm-handoff-read-model.md`
- `batch-cards/047-selected-task-scm-handoff-cli-effigy.md`
- `batch-cards/048-selected-task-scm-handoff-desktop-proof.md`
- `batch-cards/049-selected-task-scm-handoff-validation.md`

## Result

The lane proves selected-task SCM handoff readiness across server read model,
control DTOs, `nucleusd`, Effigy, and the disposable desktop proof. It remains
read-only: no branch, worktree, commit, snapshot, publication, forge request,
credential resolution, merge, provider execution, review decision, task
transition, memory apply, planning apply, or final UI authority was added.

Next lane:

- `011-product-workflow-closeout-and-next-phase-selection.md`

## Boundary

Allowed source records:

- selected task identity and task workflow drilldown refs
- task work-item refs and review state refs
- SCM handoff refs already surfaced by task workflow drilldown
- engine SCM work item linkage refs
- provider-neutral change refs
- SCM work session refs
- checkpoint refs
- diff summary refs
- runtime receipt refs
- validation refs
- change-request prep refs
- product workflow SCM readiness refs and gaps

Readiness states:

- missing: no SCM handoff evidence exists for the selected task
- blocked: evidence exists, but required checkpoint, diff, work-session,
  review, validation, or change-request prep refs are missing or repair-needed
- evidence-ready: enough checkpoint, diff, receipt, work-session, and
  provider-neutral change refs exist to explain the handoff package
- prep-ready: a change-request prep package exists and has enough evidence for
  operator review
- publication-pending: a provider-neutral publication/review target is named,
  but publication is not requested or not executed
- represented: a review, publication, gate, direct authority update, manual
  handoff, or custom provider target is already represented by refs
- repair-required: existing SCM/change refs are missing, superseded, conflicted,
  or semantically unsafe

Provider-neutral target shapes:

- forge review
- provider publication
- provider gate
- direct authority update
- manual handoff
- custom provider value
- unknown

No-effect flags:

- SCM mutation
- forge mutation
- credential resolution
- task mutation
- provider execution
- review mutation
- memory apply
- planning apply
- projection write
- UI effect

This lane may:

- summarize whether selected-task SCM handoff evidence is missing, blocked,
  prep-ready, publication-pending, or already represented by a review/publish
  ref
- show provider-neutral target shape such as forge review, provider
  publication, provider gate, direct authority update, manual handoff, or
  custom value
- show sanitized SCM work-session refs, provider-neutral change refs,
  checkpoint refs, diff summary refs, runtime receipt refs, review refs, and
  change-request prep refs
- explain missing evidence and repair-needed states without running SCM or
  forge commands
- expose read-only CLI/Effigy and desktop proof consumption

This lane must not:

- create branches, worktrees, commits, snapshots, publications, gates, pull
  requests, merge requests, issues, or comments
- stage, discard, merge, push, publish, promote, open, close, or mutate any SCM
  or forge object
- resolve credentials or call forge networks
- accept review evidence or complete tasks
- run provider execution
- apply memory or planning imports
- create final SCM diff/commit UI commitments
- let the desktop synthesize SCM handoff state

## Stop Conditions

Stop and replan if implementation requires:

- local SCM command execution
- network-backed forge execution
- credential resolution
- branch or worktree mutation
- commit, snapshot, publication, or change-request creation
- merge or conflict repair execution
- review decision commands
- task transition commands
- a new storage authority for SCM state
- client-side SCM authority
