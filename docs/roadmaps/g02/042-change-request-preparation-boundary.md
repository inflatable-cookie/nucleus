# 042 Change Request Preparation Boundary

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Prepare provider-neutral change-request records and GitHub descriptor mapping
without opening pull requests or calling forge networks.

This lane separates evidence packaging and review-boundary readiness from
provider-specific forge mutation.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/040-git-management-capture-adapter-proof.md`
- `docs/roadmaps/g02/041-scm-working-session-execution-prep.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [ ] Clarify share/review boundary policy for forges.
- [ ] Add provider-neutral change-request candidate records.
- [ ] Add GitHub review-boundary descriptors without network execution.
- [ ] Expose evidence packages for human or steward review.
- [ ] Keep pull-request creation, publication, promotion, and merge gated.

## Execution Plan

- [ ] Policy batch: define share and review-boundary authority.
- [ ] Candidate batch: add change-request candidate records.
- [ ] GitHub descriptor batch: map candidates to GitHub terminology without
      network calls.
- [ ] Evidence batch: build a reviewable evidence package read model.
- [ ] Validation batch: close the lane and select the next workflow checkpoint.

## Batch Cards

Ready cards:

- `batch-cards/191-forge-share-policy-reset.md`

Planned cards:

- `batch-cards/192-change-request-candidate-records.md`
- `batch-cards/193-github-review-boundary-descriptor.md`
- `batch-cards/194-change-request-evidence-package-read-model.md`
- `batch-cards/195-change-request-prep-validation-and-next-lane.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] Change-request candidates are provider-neutral.
- [ ] GitHub-specific terms stay adapter descriptors.
- [ ] Evidence packages can be reviewed before forge mutation.
- [ ] The next lane is selected from the long-term plan.

## Gate

Do not open pull requests, push branches, publish, promote, or merge in this
lane.
