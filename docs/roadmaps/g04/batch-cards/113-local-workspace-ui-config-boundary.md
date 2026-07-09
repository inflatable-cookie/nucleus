# 113 Local Workspace UI Config Boundary

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../024-workspace-surface-shell-skeleton.md`

## Purpose

Create the first local desktop workspace UI config boundary.

## Work

- [x] Add a desktop-side UI config DTO.
- [x] Resolve `~/.nucleus/config/ui.json`.
- [x] Create default surface state when the file does not exist.
- [x] Normalize empty surface lists and invalid active-surface refs.
- [x] Expose load/save Tauri commands.

## Acceptance Criteria

- [x] Workspace UI config is local client state.
- [x] The default config has one surface.
- [x] The default surface has `right`, `centerTop`, and `centerBottom`
  skeleton panels.
- [x] The task panel is uncloseable in the default config.
