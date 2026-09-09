# 020 Shared Work Context

Status: completed
Owner: Tom
Created: 2026-08-03

## Purpose

Make Goal, Task, active thread, Agent Chat, and Diff describe one project
working context without adding visible shell complexity or a second product
model.

## Governing Refs

- `../../contracts/005-task-contract.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/019-conversation-timeline-contract.md`
- `../../contracts/024-harness-mediation-tool-projection-contract.md`

## Generation Runway Goal

Restore one predictable project working context while keeping Agent Chat as the
normal entry point and Tasks as an optional ledger view.

## Goals

- [x] retain project-local Goal, Task, and active-conversation focus
- [x] retain each Agent Chat panel's conversation attachment
- [x] make Projects, Threads, Tasks, Agent Chat, and Diff consume one selection
- [x] reject stale or cross-project context without inventing recovery state
- [x] close with deterministic and native context-switch evidence

## Execution Plan

### Context Authority And Persistence

- [x] execute card 059
- [x] extend the existing local presentation domain instead of creating a
  renderer-owned or server-shared context model
- [x] project typed context and panel conversation attachments through the
  existing workspace snapshot boundary

### Cross-Panel Cohesion

- [x] execute cards 060 and 061
- [x] replace competing Goal, Task, and conversation stores with one workspace
  projection
- [x] synchronize sidebar thread selection, Agent Chat activation, composer
  chips, Tasks detail, and Diff focus

### Acceptance

- [x] execute card 062
- [x] prove switch, close, reopen, stale-record, restart, and multi-chat behavior
- [x] record the next inward-consolidation checkpoint without rolling generations

## Acceptance Criteria

- [x] project switching restores the selected Goal, Task, and active thread
- [x] both sidebar thread views highlight the conversation shown by Agent Chat
- [x] task selection drives composer context and Diff without requiring Tasks to
  stay open
- [x] closing or moving panels does not erase project working focus
- [x] selected focus remains advisory and grants no task or execution authority

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.


- `059-work-context-authority-and-persistence.md` — completed (collapsed into this task)
- `060-goal-task-cross-panel-focus.md` — completed (collapsed into this task)
- `061-conversation-attachment-and-sidebar-sync.md` — completed (collapsed into this task)
- `062-shared-work-context-acceptance.md` — completed (collapsed into this task)
