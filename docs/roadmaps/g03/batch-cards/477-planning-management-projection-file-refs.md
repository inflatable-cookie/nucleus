# 477 Planning Management Projection File Refs

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../114-planning-management-projection-payloads.md`

## Purpose

Add deterministic projection file refs for planning artifacts and planning task
seeds.

## Work

- [x] Add artifact file refs under `nucleus/planning/`.
- [x] Add task seed file refs under `nucleus/planning/task-seeds/`.
- [x] Validate path construction rejects unsafe ids.

## Acceptance Criteria

- [x] File refs are deterministic.
- [x] File refs do not write files.
- [x] Unsafe path traversal is rejected or impossible by construction.
