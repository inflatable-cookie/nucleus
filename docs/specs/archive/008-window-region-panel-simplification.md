# 008 Window Region Panel Simplification

Status: completed-promoted
Owner: Tom
Updated: 2026-07-13

## Problem

The inherited hosted-Surface layer created a second workspace tab hierarchy
above panel tabs. Product use showed no separate Surface workflow: the project
rail selects context, regions arrange work, and panels hold tools.

## Target Model

```text
display -> window -> region -> panel
```

- display: machine-local placement capability
- window: stable local host and region-layout identity
- region: semantic window slot
- panel: user-facing tool, tab identity, and resource attachment point

## Goals

- remove Surface identity, lifecycle, ordering, and tabs
- persist one direct window layout in the first desktop config
- preserve panel creation, focus, tabs, movement, closing, and resizing
- preserve display fallback and future multi-window foundations
- keep server resource authority outside renderer layout state

## Non-Goals

- native secondary-window creation
- arbitrary split trees
- workspace presets
- cross-device layout sync
- changes to Poodle's visual `Surface` component or design tokens

## Artifact Set

- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/008-storage-state-persistence-contract.md`
- `../../roadmaps/g04/031-window-region-panel-simplification.md`
- desktop UI config, Tauri persistence, and workspace stage
- `nucleus-workspaces` window/panel layout types

## Outcome

- Schema v2 stores one direct primary-window layout and regions.
- Schema v1 migration retains the former active Surface only.
- The product Surface strip and lifecycle controls are gone.
- Rust panel placement targets Window ids and Region ids.
- Hosted-Surface types and helpers are removed.
- Existing panel checks, builds, and focused model/config tests pass.
