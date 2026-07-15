# 038 Project Control Workflow

Status: active
Owner: Tom
Updated: 2026-07-15

## Purpose

Turn the existing read-only project rail into a minimal server-backed project
creation and lifecycle surface without introducing a setup wizard.

## Governing Refs

- `../../specs/012-flexible-project-lifecycle-and-resources.md`
- `../../architecture/project-resource-lifecycle.md`
- `../../contracts/003-project-identity-contract.md`
- `../../contracts/007-server-boundary-contract.md`

## Execution Plan

- [ ] Add create, rename, park, archive, restore, and delete admission with
  revision and authority checks.
- [ ] Add name-only creation and compact project-menu controls to the rail.
- [ ] Preserve selected-project and workspace behavior across lifecycle
  changes and restart.
- [ ] Validate empty durable projects before resource attachment begins.

## Batch Cards

Ready:

- `batch-cards/187-project-lifecycle-command-boundary.md`

Planned:

- `batch-cards/188-minimal-project-rail-controls.md`
- `batch-cards/189-project-control-validation.md`
