# 031 First Harness Target Decision

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../009-harness-runtime-target-selection.md`

## Purpose

Select the first real harness runtime target and one comparison target.

The decision should optimize for proving the Nucleus adapter architecture,
not for broad provider coverage on day one.

## Scope

- Choose one first implementation target.
- Choose one comparison target that stresses different adapter assumptions.
- Record why alternatives are deferred.
- Define required provider event ingestion, cancellation, permission, resume,
  terminal fallback, and message identity rules for the chosen target.
- Update contracts only where the decision changes durable rules.
- Keep UI panels, SCM mutation, and remote client transport out of scope.

## Acceptance Criteria

- The milestone names the selected first target and comparison target.
- The decision is backed by refreshed evidence and risk comparison.
- Required identity and lifecycle mappings are explicit enough to compile an
  implementation runway.
- Deferred candidates have clear reasons, not silent omission.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if no target has enough evidence to implement without guessing.
- Stop if the selected first target would bypass the orchestration and runtime
  receipt boundaries.

## Outcome

Selected Codex app-server/runtime as the first bridged harness target and Pi
RPC as the comparison target.

Promoted the decision into
`docs/contracts/002-harness-adapter-contract.md` without adding runtime
behavior.
