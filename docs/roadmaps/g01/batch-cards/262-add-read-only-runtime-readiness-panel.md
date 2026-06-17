# 262 Add Read-Only Runtime Readiness Panel

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a disposable Svelte panel that renders runtime readiness diagnostics.

## Scope

- Query `queryRuntimeReadiness`.
- Render records, blockers, evidence refs, repair hints, and summary.
- Keep loading and error states explicit.

## Out Of Scope

- Runtime repair.
- Command execution.
- Artifact payload retrieval.

## Promotion Targets

- `apps/desktop/src/lib`

## Acceptance Criteria

- Users can see why local runtime execution is unsupported or ready.
- The panel depends on DTO helpers, not storage records.

## Outcome

Added `RuntimeReadinessPanel.svelte` backed by `queryRuntimeReadiness`.
