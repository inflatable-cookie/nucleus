# 039 Multi-Resource Attachment And Targeting

Status: active
Owner: Tom
Updated: 2026-07-15

## Purpose

Attach plain folders and Git repositories to projects, then make filesystem
panels and agent work resolve explicit host-owned resource targets.

## Governing Refs

- `../../specs/012-flexible-project-lifecycle-and-resources.md`
- `../../architecture/project-resource-lifecycle.md`
- `../../contracts/003-project-identity-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`
- `../../contracts/029-terminal-panel-runtime-contract.md`

## Execution Plan

- [x] Add host-side folder/Git detection plus attach, update, repair, and
  remove commands.
- [x] Replace operational `primary_location` use with explicit or default
  resource resolution across chat, editor, terminal, browser, and diff.
- [x] Add compact resource management and show selectors only when ambiguity
  or repair requires them.
- [ ] Validate zero, one, and many resources across local and remote authority
  shapes.

## Batch Cards

Completed:

- `batch-cards/190-resource-attachment-and-repair-boundary.md`
- `batch-cards/191-workspace-resource-target-resolution.md`
- `batch-cards/192-compact-project-resource-controls.md`

Ready:

- `batch-cards/193-multi-resource-workflow-validation.md`
