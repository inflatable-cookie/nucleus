# 041 Shared Project Files Control

Status: planned
Owner: Tom
Updated: 2026-07-15

## Purpose

Expose the existing Git-backed management projection as an optional advanced
project capability after core project and resource workflows are usable.

## Governing Refs

- `../../specs/002-git-backed-project-management-state.md`
- `../../specs/012-flexible-project-lifecycle-and-resources.md`
- `../../contracts/003-project-identity-contract.md`
- `../../contracts/011-scm-forge-sync-contract.md`
- `../../architecture/project-resource-lifecycle.md`

## Execution Plan

- [ ] Bind one active management projection to an existing or dedicated Git
  resource with explicit sync policy.
- [ ] Reconcile existing management projection/sync machinery with the new
  resource identity and host authority model.
- [ ] Add **Shared project files** configuration and diagnostics behind the
  project menu.
- [ ] Validate export, import, repair, conflict, and disabled-projection paths
  without making Git mandatory.

## Batch Cards

Planned:

- `batch-cards/197-management-projection-resource-binding.md`
- `batch-cards/198-shared-project-files-controls.md`
- `batch-cards/199-shared-project-files-validation.md`
