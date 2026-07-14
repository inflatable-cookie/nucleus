# 162 Window Panel Model Promotion

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../031-window-region-panel-simplification.md`
Auto-start next card: yes

## Objective

Make `display -> window -> region -> panel` the only canonical layout model.

## Governing Refs

- `../../../specs/archive/008-window-region-panel-simplification.md`
- `../../../architecture/product-workflow-ui-architecture.md`
- `../../../contracts/006-workspace-layout-contract.md`

## Scope

1. Promote the hierarchy, authority split, panel attachments, and local state.
2. Supersede the inherited Surface spec.
3. Remove stale Surface claims from active architecture and persistence docs.
4. Compile the bounded implementation runway.

## Acceptance Criteria

- active architecture and contracts name no hosted-Surface requirement
- spec records the accepted simplification and non-goals
- roadmap and four-card runway are ready

## Validation

- `effigy qa:docs`
- `git diff --check`

## Evidence

- canonical doc diff
- passing docs and diff checks

## Stop Conditions

- another active contract requires Surface identity for product behavior

## Next

Auto-start card 163.

## Outcome

- Canonical hierarchy, authority, and persistence rules now omit hosted
  Surfaces.
- The old Surface spec is archived and the four-card implementation runway was
  compiled.
