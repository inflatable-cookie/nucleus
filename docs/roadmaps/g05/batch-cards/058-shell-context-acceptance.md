# 058 Shell Context Acceptance

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../019-shell-context-cohesion.md`
Depends on: card 057
Auto-start next card: no

## Objective

Prove project-switch isolation and sparse recovery across deterministic and
native desktop paths, then leave one next inward-consolidation task.

## Acceptance

- [x] rapid switches are latest-selection-wins
- [x] each project restores its own panels, active tabs, regions, and sizing
- [x] empty and failed workspaces preserve shell navigation
- [x] restart restores the selected project's retained layout without cross-project bleed
- [x] the operator selects or confirms the next g05 inward lane

## Validation

- [x] focused desktop, Svelte, docs, and diff-hygiene checks pass
- [x] native shell switching and recovery evidence is recorded

## Stop Conditions

- authenticated provider activity is outside this shell lane

## Evidence

A fresh release bundle proved immediate last-panel replacement, direct Agent
Chat recovery, rapid latest-selection-wins switching, ordinary project layout
restoration, and relaunch persistence. No provider work ran.

The operator selected shared Goal, Task, selection, and agent-conversation
context as the next inward-consolidation lane.
