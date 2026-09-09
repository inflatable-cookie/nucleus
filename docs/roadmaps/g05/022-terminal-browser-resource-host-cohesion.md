# 022 Terminal Browser Resource Host Cohesion

Status: completed
Owner: Tom
Created: 2026-08-04

## Purpose

Make Terminal and Browser feel like coherent project tools while preserving
their different runtime boundaries and keeping healthy local state quiet.

## Governing Refs

- `../../contracts/003-project-identity-contract.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/028-browser-panel-runtime-contract.md`
- `../../contracts/029-terminal-panel-runtime-contract.md`
- `019-shell-context-cohesion.md`

## Generation Runway Goal

Restore one predictable project working context while keeping resource choice,
runtime host evidence, and recovery inside the panel that owns them.

## Goals

- [x] settle the distinct Browser, Terminal, resource, and host boundaries
- [x] use one effective resource projection for panel chrome and host requests
- [x] make Terminal opening, failure, retry, and non-local host evidence truthful
- [x] keep Browser recovery trusted, local, and free of fake resource targeting
- [x] close with deterministic and native workflow evidence

## Execution Plan

### Authority And Shared Target Projection

- [x] execute cards 067 and 068
- [x] promote sparse status and target rules into the governing contracts
- [x] remove duplicated client effective-target selection

### Panel Runtime Presentation

- [x] execute card 069
- [x] align Terminal rendering with theme tokens and exact retry semantics
- [x] add bounded Browser child recovery without broadening its trust boundary

### Acceptance

- [x] execute card 070
- [x] prove zero, one, multiple, broken, and non-local resource contexts
- [x] prove remount, project switch, failure, retry, and Browser overlay behavior

## Acceptance Criteria

- [x] the target shown by panel chrome is the target sent to its host request
- [x] a healthy sole local resource and host add no permanent chrome
- [x] Terminal reports actual session-host evidence and never guesses from layout
- [x] Browser remains a local native child with trusted, bounded recovery
- [x] target or host failure never resets layout or silently falls back
- [x] the normal path gains no global connection bar or duplicate resource model

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.


- `067-panel-runtime-authority-and-status.md` — completed (collapsed into this task)
- `068-shared-resource-target-projection.md` — completed (collapsed into this task)
- `069-terminal-browser-runtime-presentation.md` — completed (collapsed into this task)
- `070-terminal-browser-resource-acceptance.md` — completed (collapsed into this task)
