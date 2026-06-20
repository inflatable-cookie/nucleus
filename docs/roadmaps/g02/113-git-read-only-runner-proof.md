# 113 Git Read Only Runner Proof

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Introduce the first real read-only Git runner proof for status and diff-stat
commands while preserving the dry-run authority model and retaining only
sanitized summaries.

## Governing Refs

- `docs/roadmaps/g02/110-git-dry-run-command-execution-boundary.md`
- `docs/roadmaps/g02/111-git-dry-run-command-execution-persistence.md`
- `docs/roadmaps/g02/112-git-dry-run-execution-control-integration.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a constrained read-only Git runner adapter.
- [x] Parse porcelain status output into bounded counts.
- [x] Parse diff-stat output into bounded counts.
- [x] Persist sanitized evidence from real read-only execution only after
  explicit runner admission.
- [x] Prove checkout, branch, commit, push, forge, provider, callback,
  interruption, recovery, and raw-output authority remain blocked.

## Execution Plan

- [x] Read-only runner adapter batch.
- [x] Status summary parser batch.
- [x] Diff-stat summary parser batch.
- [x] Runner authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/529-git-read-only-runner-adapter.md`
- `batch-cards/530-git-status-summary-parser.md`
- `batch-cards/531-git-diff-stat-summary-parser.md`
- `batch-cards/532-git-read-only-runner-authority.md`
- `batch-cards/533-git-read-only-runner-closeout.md`

## Acceptance Criteria

- [x] Runner only accepts admitted non-mutating Git descriptors.
- [x] Status and diff-stat parsing retain counts and refs only.
- [x] Raw stdout, stderr, and diff bodies are not retained in core records.
- [x] Mutating Git and external authority remain blocked.
- [x] Validation passes or blockers are recorded.
