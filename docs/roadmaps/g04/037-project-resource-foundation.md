# 037 Project Resource Foundation

Status: completed
Owner: Tom
Updated: 2026-07-15

## Purpose

Replace the repo-only project core with a resource-aware, retention-aware
domain and durable server record before new project UI depends on it.

## Governing Refs

- `../../specs/012-flexible-project-lifecycle-and-resources.md`
- `../../architecture/project-resource-lifecycle.md`
- `../../contracts/003-project-identity-contract.md`
- `../../contracts/008-storage-state-persistence-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`

## Execution Plan

- [x] Promote the accepted project, resource, retention, and projection shape.
- [x] Generalize the Rust domain and migrate existing repo-oriented records.
- [x] Add server-owned project/resource read models and command boundaries.
- [x] Validate zero-resource, folder, Git, multi-resource, and remote-host
  invariants before product controls consume them.

## Batch Cards

Completed:

- `batch-cards/183-project-resource-model-promotion.md`
- `batch-cards/184-project-resource-domain-and-storage.md`
- `batch-cards/185-project-resource-control-boundary.md`
- `batch-cards/186-project-resource-foundation-validation.md`
