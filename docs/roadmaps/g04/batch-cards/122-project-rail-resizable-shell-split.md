# 122 Project Rail Resizable Shell Split

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Make the full-height project rail resizable without changing project-scoped
panel layout semantics.

## Scope

- replace the root fixed grid columns with a Poodle `SplitView`
- keep the project rail full height
- persist the project rail ratio as local client shell state
- keep the workspace header and stage inside the secondary split pane
- style the shell divider consistently with workspace split handles

## Acceptance

- the left project rail width can be adjusted by dragging the divider
- the workspace remains full height and does not overlap the project rail
- the rail width is treated as local client UI state, not project state
- desktop type checking passes
