# 445 Next Task Readiness Surface Selection

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Select the first bounded task/project implementation slice from audit evidence.

## Work

- [x] Evaluate next-task/readiness projection feasibility.
- [x] Evaluate task planning artifact linkage feasibility.
- [x] Evaluate task timeline/work-item evidence gap feasibility.
- [x] Choose one first slice and document why the others are deferred.

## Acceptance Criteria

- [x] Selected slice has clear Rust modules, tests, and control surface.
- [x] Selection does not rely on uncontracted scoring or UI design.
- [x] Deferred slices remain visible for later roadmap work.

## Decision

Implement a deterministic read-only task readiness candidate projection.

First slice:

- query task records by project
- classify candidates with existing fields only
- expose reasons, blockers, and evidence refs
- return status/source counts
- make mutation and provider execution flags explicit false

Deferred:

- priority scoring
- goal-loop next-task automation
- planning artifact promotion
- task seed promotion
- visible UI design
- provider execution
