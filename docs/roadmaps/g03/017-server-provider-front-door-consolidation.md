# 017 Server Provider Front-Door Consolidation

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Reduce flat `nucleus-server` front-door pressure from the G03 provider record
tranche without merging focused modules into god files.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g03/016-g03-health-validation-rebaseline.md`
- `AGENTS.md`

## Goals

- [x] Define the grouping boundary for adapter-neutral and Convergence provider
  modules.
- [x] Move exports behind grouped module fronts without changing behavior.
- [x] Preserve small focused files and tests.
- [x] Keep all execution effects false.

## Execution Plan

- [x] Consolidation plan batch.
- [x] Module grouping batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/064-server-provider-front-door-consolidation-plan.md`
- `batch-cards/065-server-provider-front-door-module-grouping.md`
- `batch-cards/066-server-provider-front-door-closeout.md`

## Acceptance Criteria

- [x] The grouped front door reduces flat `lib.rs` provider entries.
- [x] Public re-exports remain available through a clear server provider
  surface.
- [x] Focused module files remain small and domain-specific.
- [x] Focused adapter-neutral and Convergence tests still pass.
