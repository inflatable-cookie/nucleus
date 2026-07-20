# 001 Project Layout Store And Migration

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../001-project-scoped-workspace-layouts.md`
Auto-start next card: yes

## Objective

Persist global native-window placement separately from project-keyed panel and
region layouts.

## Acceptance

- [x] persisted project layouts are keyed by exact project id
- [x] the current single layout is retained as a one-time migration candidate
- [x] first load claims the candidate; later unseen projects get Agent Chat only
- [x] renderer saves cannot overwrite host-owned native placement

## Validation

- focused `workspace_ui` Rust tests
- migration fixtures for schemas 1 through 6 and project isolation

## Stop Conditions

- project layout becomes authoritative project/server state
- native window geometry becomes project-scoped
- every new project inherits the old global tool set
