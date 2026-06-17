# 044 Command Diagnostics Panel Hardening

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Make the first disposable command diagnostics panel useful enough for local
server work without expanding command authority.

## Scope

- Seed or produce realistic local command evidence for the desktop panel.
- Verify the panel renders list/detail/empty/error states.
- Keep command diagnostics read-only.
- Keep artifact payloads, streaming output, PTY, retry, cancellation, and
  approval controls out.
- Reassess the next server/runtime diagnostics lane.

## Out Of Scope

- Final UI design.
- Artifact payload retrieval.
- Streaming process output.
- Write-enabled command controls.
- Remote transport.

## Decisions

- The disposable panel can be implemented because it consumes typed DTOs only.
- The next risk is usefulness: an empty command history panel is structurally
  correct but weak for local development.
- Realistic evidence should come from server-owned command paths or explicit
  seed helpers, not Svelte fixtures.

## Execution Plan

- [x] Add local command evidence seed or sample production path for desktop.
- [x] Render command diagnostics from seeded evidence.
- [x] Verify the panel with desktop checks and a browser/screenshot pass where
  practical.
- [x] Add regression coverage for forbidden command controls.
- [x] Reassess next diagnostics/server runtime lane.

## Acceptance Criteria

- The panel can show at least one realistic command evidence record.
- The panel still consumes typed DTOs only.
- The panel has no execution or artifact payload controls.
- The next runtime diagnostics step is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/251-add-desktop-command-evidence-seed.md`
- `docs/roadmaps/g01/batch-cards/252-render-seeded-command-diagnostics.md`
- `docs/roadmaps/g01/batch-cards/253-verify-command-diagnostics-panel.md`
- `docs/roadmaps/g01/batch-cards/254-add-forbidden-command-control-regression.md`
- `docs/roadmaps/g01/batch-cards/255-reassess-next-runtime-diagnostics-lane.md`

## Outcome

Desktop startup now seeds deterministic sanitized command evidence through
Rust server state. The disposable command diagnostics panel renders that
record through typed DTOs, and tests guard against storage payload leakage and
premature command controls.

Validation covered Rust tests, Svelte checks, production web build, docs QA,
and local dev-server response. T3 preview automation was unavailable for this
thread, so no screenshot evidence was captured.

Next lane: runtime readiness diagnostics query shape. Command history can now
show what happened; runtime readiness should explain what the local host can
or cannot do before richer command controls are considered.
