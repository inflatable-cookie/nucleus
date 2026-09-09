# 019 Shell Context Cohesion

Status: completed
Owner: Tom
Created: 2026-08-03

## Purpose

Make project switching feel like a complete context change while keeping the
global shell stable and the recovery path sparse.

## Governing Refs

- `../../contracts/006-workspace-layout-contract.md`
- `001-project-scoped-workspace-layouts.md`
- `002-workspace-sidebar-modes.md`

## Generation Runway Goal

Restore one predictable project workspace without leaking the previous
project's panel or command context.

## Goals

- [x] enforce a hard renderer epoch at project selection changes
- [x] keep launcher and command facts scoped to the selected project
- [x] give empty and failed workspaces one clear recovery path
- [x] close with deterministic and native shell-switch evidence

## Execution Plan

### Switch Epoch And Context Isolation

- [x] execute card 056
- [x] stop rendering the previous project before the next layout arrives
- [x] clear old launcher and active-panel facts during the transition

### Sparse Workspace Recovery

- [x] execute card 057
- [x] preserve an intentionally empty persisted layout
- [x] expose direct Agent Chat recovery and bounded reconnect states

### Acceptance

- [x] complete card 058 after next-lane selection
- [x] prove rapid switching, empty recovery, failure isolation, and restart
- [x] update generation currentness without rolling generations

## Acceptance Criteria

- [x] no previous-project panel body or command fact appears after selection changes
- [x] latest selection wins when switches overlap layout publication
- [x] an empty retained workspace remains empty until the operator opens a panel
- [x] layout failure does not disable project navigation or invent a reset
- [x] one clear g05 next task remains

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.


- `056-shell-switch-epoch-and-context-isolation.md` — completed (collapsed into this task)
- `057-empty-workspace-and-reconnect-recovery.md` — completed (collapsed into this task)
- `058-shell-context-acceptance.md` — completed (collapsed into this task)

## Current Boundary

Project selection remounts the renderer epoch, clears shell command facts, and
restores only the selected project's layout. Empty layouts are retained and
recover directly to Agent Chat. Focused desktop validation and a fresh native
release-bundle pass cover immediate last-panel close, direct recovery, rapid
switching, normal restoration, and relaunch. The operator selected shared Goal,
Task, selection, and agent-conversation context as roadmap 020.
