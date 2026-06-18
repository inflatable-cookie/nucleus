# 037 Repo Backed Management Sync Hardening

Status: active
Owner: Tom
Updated: 2026-06-18

## Purpose

Harden the repo-backed management projection so project and task state can be
committed, shared, imported, and repaired without treating runtime state as
committable source.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Define local-only versus committable management records.
- [ ] Prove export/import behavior for project and task projection files.
- [ ] Surface conflicts without silent overwrite.
- [ ] Keep runtime progress, provider state, UI layout, and secrets local-only.

## Execution Plan

- [x] Policy batch: document projection authority and local-only exclusions.
- [ ] Export batch: harden project/task projection file output.
- [ ] Import batch: harden deterministic import staging and conflict detection.
- [ ] Assistance batch: route sync conflicts into steward-assistable proposals.
- [ ] Validation batch: run repo-backed projection tests and close the lane.

## Batch Cards

Ready cards:

- `batch-cards/165-project-task-projection-export-hardening.md`

Completed cards:

- `batch-cards/164-management-projection-authority-policy.md`

Planned cards:

- `batch-cards/166-projection-import-conflict-fixtures.md`
- `batch-cards/167-management-sync-assistance-routing-proof.md`
- `batch-cards/168-management-sync-hardening-validation.md`

## Acceptance Criteria

- [ ] The repo-backed projection rules distinguish shared management state from
      local runtime state.
- [ ] Export/import tests cover project and task records.
- [ ] Conflict handling is deterministic and visible.
- [ ] No runtime provider payloads, UI layout, local session state, secrets, or
      command output are made committable by default.

## Gate

Do not start steward automation or richer UI workflow work until projection
authority is clearer.
