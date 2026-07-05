# 548 Planning Import Active Apply Executor Boundary

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../125-planning-import-active-apply-executor-boundary.md`

## Purpose

Define the executor boundary over admitted active-apply records.

## Work

- [x] Define required persisted admission inputs.
- [x] Define executor authority refs, receipt refs, revision checks, and stop
  conditions.
- [x] Define deferred effects that remain out of scope.
- [x] Decide whether the next model should be stopped executor planning or
  direct mutation runner design.

## Acceptance Criteria

- [x] Executor authority is distinct from admission authority.
- [x] Actual planning mutation remains out of scope for this card.
- [x] Task creation, provider execution, SCM/forge mutation, accepted memory
  mutation, semantic merge automation, and UI behavior remain blocked.

## Decision

Proceed with stopped executor planning. Do not design the direct mutation runner
until executor plan and stopped receipt records exist, are persisted, and have
read-only diagnostics.
