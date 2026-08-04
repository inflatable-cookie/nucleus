# 078 Container Relative Panel Composition

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../024-shell-accessibility-responsive-and-failure-cohesion.md`
Depends on: card 077
Auto-start next card: no

## Objective

Make movable panel composition respond to the panel container rather than the
outer native window.

## Acceptance

- [x] panel roots establish explicit inline-size containers where adaptation is needed
- [x] panel viewport media queries become container queries
- [x] narrow Task, Agent Chat, Editor, Diff, and Forge Diff layouts retain primary actions
- [x] chrome has no horizontal scroll and content overflow remains panel-local
- [x] persisted region ratios are unchanged by responsive presentation

## Validation

- [x] focused responsive policy, mounted panel fixtures, isolated narrow native evidence, and desktop build pass

## Stop Conditions

- pause a specialist panel rather than inventing hidden actions or workflow changes
- do not persist breakpoint or measured-width state

## Evidence

- Tasks, Agent Chat, Editor, Diff, and Forge Diff establish named inline-size
  containers and no longer use viewport media queries for panel composition.
- Focused source-policy fixtures guard container ownership and Tasks stacking.
- The supported native minimum width keeps Agent Chat and Tasks primary actions
  visible. The project count contracts to its numeric form in the narrow rail.
- Responsive presentation does not write layout or breakpoint state.
