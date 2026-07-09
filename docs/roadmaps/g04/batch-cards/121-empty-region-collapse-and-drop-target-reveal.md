# 121 Empty Region Collapse And Drop Target Reveal

Status: completed
Owner: Tom
Updated: 2026-07-09

## Purpose

Keep the surface shell clean by hiding empty regions during normal use while
still exposing valid drop targets during panel drags.

## Scope

- derive region visibility from panel presence or active allowed drop target
- hide empty `left`, `right`, `centerTop`, and `centerBottom` regions
- remove split dividers when only one side of a split is visible
- reveal empty regions during a drag only when the dragged panel may be dropped
  there
- keep a minimal empty-workspace fallback for the impossible all-empty state

## Acceptance

- moving the last panel out of a region collapses that region
- dragging a panel reveals empty regions only when allowed by placement policy
- center/right and centerTop/centerBottom split dividers disappear when one
  side is hidden
- desktop type checking passes
