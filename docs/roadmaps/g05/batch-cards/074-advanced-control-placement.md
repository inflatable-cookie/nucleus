# 074 Advanced Control Placement

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../023-memory-provider-and-advanced-control-cohesion.md`
Depends on: card 073
Auto-start next card: yes

## Objective

Keep normal panels sparse by placing low-frequency, diagnostic, credential,
and destructive controls behind deliberate Settings, menu, popover, or
disclosure entry points.

## Acceptance

- [x] every visible advanced control has one clear product owner and placement
- [x] normal panels lead with the current object and primary action
- [x] diagnostic refs and counts stay behind disclosures or dedicated diagnostics
- [x] destructive and credential actions remain in Settings or explicit confirmation flows
- [x] no capability is removed solely to simplify presentation

## Validation

- [x] focused shell, panel, settings, accessibility, and narrow-layout checks pass

## Stop Conditions

- do not redesign specialist workflows without operator-shaped product rules

## Evidence

- Memory ids, actor refs, retention, counts, and supersession remain under
  `Details`; Tasks and workflow receipts retain their existing advanced/detail
  disclosures.
- destructive project, resource, and file actions remain menu-owned and
  confirmation-bound. Credential lifecycle actions remain Settings-owned.
- exact provider instance, revision, driver, and facade evidence moved behind
  `Technical details`; readiness and actionable credential posture stay visible.
- no control or capability was removed. Mounted Settings, Svelte, and desktop
  build checks pass. The existing ProjectRail accessibility warning is unchanged.
