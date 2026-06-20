# 114 Git Read Only Runner Evidence Composition

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Compose real read-only Git runner output into sanitized evidence capture and
persistence records without retaining raw output or granting mutation authority.

## Governing Refs

- `docs/roadmaps/g02/111-git-dry-run-command-execution-persistence.md`
- `docs/roadmaps/g02/112-git-dry-run-execution-control-integration.md`
- `docs/roadmaps/g02/113-git-read-only-runner-proof.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Map read-only runner outputs to sanitized evidence capture records.
- [x] Persist composed Git dry-run execution records from real read-only runs.
- [x] Keep control diagnostics updated from persisted composed records.
- [x] Prove raw output is transient and never persisted.
- [x] Keep checkout, branch, commit, push, forge, provider, callback,
  interruption, and recovery authority blocked.

## Execution Plan

- [x] Runner-output to evidence-capture batch.
- [x] Runner evidence persistence composition batch.
- [x] Control diagnostics refresh batch.
- [x] Integrated authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/534-git-runner-output-to-evidence-capture.md`
- `batch-cards/535-git-runner-evidence-persistence-composition.md`
- `batch-cards/536-git-runner-control-diagnostics-refresh.md`
- `batch-cards/537-git-runner-integrated-authority.md`
- `batch-cards/538-git-runner-evidence-composition-closeout.md`

## Acceptance Criteria

- [x] Real read-only runner output maps to sanitized capture counts.
- [x] Persisted composed records contain refs and counts only.
- [x] Control diagnostics reflect composed persisted records.
- [x] Raw stdout, stderr, path names, and diff bodies are not persisted.
- [x] Mutating Git and external effects remain blocked.
