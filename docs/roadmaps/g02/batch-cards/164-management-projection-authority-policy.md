# 164 Management Projection Authority Policy

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../037-repo-backed-management-sync-hardening.md`

## Purpose

Define which management records can be committed to a project repo and which
records must remain local-only.

## Scope

- Document committable project/task/planning state.
- Document local-only runtime, provider, UI layout, secret, and cache state.
- Update architecture/contracts if policy becomes durable.

## Acceptance Criteria

- Shared task/project state is separated from runtime state.
- The policy does not assume Git-only terminology.
- Future export/import code has a clear authority target.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the policy requires operator product direction.
