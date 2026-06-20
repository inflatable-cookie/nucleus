# 114 Git Read Only Runner Evidence Composition

Status: active
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

- [ ] Map read-only runner outputs to sanitized evidence capture records.
- [ ] Persist composed Git dry-run execution records from real read-only runs.
- [ ] Keep control diagnostics updated from persisted composed records.
- [ ] Prove raw output is transient and never persisted.
- [ ] Keep checkout, branch, commit, push, forge, provider, callback,
  interruption, and recovery authority blocked.

## Execution Plan

- [ ] Runner-output to evidence-capture batch.
- [ ] Runner evidence persistence composition batch.
- [ ] Control diagnostics refresh batch.
- [ ] Integrated authority regression batch.
- [ ] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

- `batch-cards/534-git-runner-output-to-evidence-capture.md`

Planned cards:

- `batch-cards/535-git-runner-evidence-persistence-composition.md`
- `batch-cards/536-git-runner-control-diagnostics-refresh.md`
- `batch-cards/537-git-runner-integrated-authority.md`
- `batch-cards/538-git-runner-evidence-composition-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Real read-only runner output maps to sanitized capture counts.
- [ ] Persisted composed records contain refs and counts only.
- [ ] Control diagnostics reflect composed persisted records.
- [ ] Raw stdout, stderr, path names, and diff bodies are not persisted.
- [ ] Mutating Git and external effects remain blocked.
