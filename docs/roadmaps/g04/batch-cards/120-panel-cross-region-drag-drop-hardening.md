# 120 Panel Cross Region Drag Drop Hardening

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Make panel tabs movable between allowed workspace regions without losing
same-region tab reorder behavior.

## Scope

- capture panel-tab drag state at the workspace region wrapper
- keep same-region tab reorder delegated to Poodle `DockRegion`
- move panels across regions only when the target is in `allowed_regions`
- show visible drop targets for every allowed target region during a drag
- show a stronger hover state for the active target region

## Acceptance

- a new terminal created in `centerTop` can be dragged to `centerBottom`
- invalid regions do not accept the drop
- allowed regions show a dropzone indicator while dragging
- desktop type checking passes
