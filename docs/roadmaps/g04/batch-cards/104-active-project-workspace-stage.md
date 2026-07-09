# 104 Active Project Workspace Stage

Status: completed
Owner: Tom
Updated: 2026-07-08
Milestone: `../021-product-shell-project-rail.md`

## Purpose

Make the central workspace respond to the active project selected in the left
rail.

## Work

- [x] Add a product-shell stage component outside the proof harness.
- [x] Show active project identity and current empty/ready state.
- [x] Keep task/workflow content as placeholders until placement is selected.
- [x] Preserve proof harness isolation.

## Acceptance Criteria

- [x] Selecting a project changes the main workspace state.
- [x] The center panel is no longer blank in normal operation.
- [x] No mutation controls or proof widgets are added to the product shell.

## Result

Added `ProjectWorkspaceStage` as the normal center-stage product shell
component and wired it to the active project selected in `ProjectRail`.

The stage shows empty/loading states, active project identity, and bounded
workspace/workflow placeholders. It does not expose mutation controls or move
proof widgets out of the proof harness modal.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
