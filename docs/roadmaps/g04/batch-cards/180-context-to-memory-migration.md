# 180 Context To Memory Migration

Status: completed
Owner: Codex
Updated: 2026-07-14
Milestone: `../036-project-memory-panel.md`
Auto-start next card: yes

## Objective

Replace the undefined Context panel kind with Memory across domain defaults,
desktop launchers, and persisted local UI configuration.

## Governing Refs

- `../../../contracts/013-shared-memory-contract.md`
- `../../../contracts/006-workspace-layout-contract.md`
- `../036-project-memory-panel.md`

## Scope

- rename new/default panel definitions from Context to Memory
- migrate existing `context` records during config normalization
- preserve panel id, region, order, closeability, and movability
- add focused migration guards

## Acceptance

- no product launcher or default creates a Context panel
- old Context tabs reopen as Memory in their prior placement
- unrelated context vocabulary remains untouched

## Validation

- focused `nucleus-desktop` workspace UI tests
- desktop type check

## Stop Conditions

- migration would require discarding the user's panel layout
- Memory needs new server mutation authority

## Outcome

Workspace UI schema v5 migrates `context` panels to `memory` in place. New
domain defaults, desktop defaults, icons, labels, and launcher entries now use
Memory. Panel identity and placement remain stable.
