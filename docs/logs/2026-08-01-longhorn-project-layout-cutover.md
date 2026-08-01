# Longhorn Project Layout Cutover

Date: 2026-08-01
Status: implemented

## Decision

Nucleus project layout now uses Longhorn structural authority. The desktop
registers the accepted five-region schema, four sizing slots, and product panel
definitions. Each project maps to one deterministic layout container. New
projects seed exactly one Agent Chat panel.

The registered `nucleus.project-layouts` domain stores only Longhorn layout
state. Nucleus-owned titles, external panel ids, resource targets, editor file
refs, and forge diff refs live in the separate
`nucleus.panel-presentations` domain. Window placement remains an independent
registered state domain.

## Migration

Raw workspace schemas 1 through 10 convert backup-first. Project-keyed layouts
retain their panels, order, active tabs, regions, and sizing. A legacy single
layout becomes a pending candidate claimed once by the first project loaded.
The original bytes and a migration receipt remain in the backup root.

## Mutation Boundary

The temporary renderer snapshot DTO now carries the authoritative layout
revision. The host translates each accepted snapshot into strict Longhorn
create, close, activate, reorder, move, and resize commands against fresh
registered state. Renderer operations are serialized, and sizing writes retain
the existing 200 ms bound. Card 099 will replace this transition DTO with the
generated mutation client.

Rejected, invalid, and stale mutations leave the layout document and revision
unchanged. Project switching is guarded by captured project identity and an
ordered host-operation lane.

## Removed Duplicate Mechanics

Unused `nucleus-workspaces` display, geometry, window, region, local-layout,
project-panel, and fallback-planning modules were removed. The crate retains
only server-facing product planning records and is not desktop layout
authority. Resources, terminal/browser handles, panel bodies, and cleanup stay
outside Longhorn.

## Evidence

- desktop workspace-layout tests cover project isolation, exact seed policy,
  stale and invalid failure invariance, schemas 1 through 10, pending-layout
  claim, product metadata separation, and window/layout independence
- the Longhorn Nucleus conformance fixture now matches the accepted region and
  sizing schema exactly
- Svelte checks and renderer tests pass; one unrelated pre-existing
  `ProjectRail.svelte` accessibility warning remains
