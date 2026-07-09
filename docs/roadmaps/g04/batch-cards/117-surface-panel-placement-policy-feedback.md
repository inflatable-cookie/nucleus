# 117 Surface Panel Placement Policy Feedback

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../024-workspace-surface-shell-skeleton.md`

## Purpose

Apply operator feedback from the first surface-shell screenshot.

## Work

- [x] Remove the redundant active-surface title strip below the surface tabs.
- [x] Keep surface rename available through compact surface-strip actions.
- [x] Tighten panel tab strip chrome without replacing Poodle components.
- [x] Add explicit `allowed_regions` policy to local panel records.
- [x] Reject cross-region panel drops outside each panel's allowed-region map.
- [x] Persist allowed cross-region moves in `~/.nucleus/config/ui.json`.

## Acceptance Criteria

- [x] Surface tabs remain Poodle `Tabs`.
- [x] Panel regions remain Poodle `DockRegion`.
- [x] Panel tabs are reorderable.
- [x] Panel tabs are movable between regions only where allowed.
- [x] The task system panel is movable between `centerTop` and `centerBottom`
  but remains uncloseable.
