# 119 Panel Recovery Menu And Resizable Regions

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Make the surface shell usable after closeable tabs are closed, and bring in the
first Loophole-style resizable region frame.

## Scope

- add a top-level `+` menu for creating new workspace panel instances
- support new chat, terminal, browser, editor, diff, and context panels
- keep panel placement constrained by each panel's allowed-region policy
- replace fixed region sizing with Poodle `SplitView` nesting
- persist surface split ratios in local workspace UI config
- document the recovery menu and split-ratio state as shell behavior, not final
  workflow design

## Acceptance

- closing all closeable tabs does not leave the user without a way to reopen
  tool panels
- created panels appear in their default allowed region and become active
- center/right and centerTop/centerBottom regions are resizable
- local UI config round-trips split ratios through the Tauri command boundary
- desktop type checking and focused workspace UI tests pass
