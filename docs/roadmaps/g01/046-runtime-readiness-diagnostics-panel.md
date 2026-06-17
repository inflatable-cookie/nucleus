# 046 Runtime Readiness Diagnostics Panel

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Render local runtime readiness diagnostics in the disposable desktop shell
without adding command authority.

## Scope

- Define the panel boundary.
- Query `get_local_runtime_readiness` through the existing desktop helper.
- Render host id, runtime surface, status, blockers, evidence refs, repair
  hints, and summary.
- Keep unsupported, blocked, empty, error, and unexpected states distinct.
- Add regression coverage that no execution controls appear in the readiness
  panel.
- Reassess whether the next lane should be artifact metadata detail, command
  event timeline, or runtime readiness refinement.

## Out Of Scope

- Command execution.
- Runtime repair actions.
- Artifact payload retrieval.
- Terminal, PTY, or streaming output.
- Final UI design.

## Decisions

- The first readiness panel is disposable proof UI.
- Rust control DTOs remain the authority boundary.
- Readiness diagnostics may guide user understanding but must not become a
  command approval path.

## Execution Plan

- [x] Define disposable readiness diagnostics panel boundary.
- [x] Add read-only runtime readiness panel.
- [x] Wire panel into the desktop shell.
- [x] Add forbidden readiness control regression.
- [x] Verify panel behavior and pick the next diagnostics lane.

## Outcome

- Added a disposable read-only runtime readiness panel.
- Wired the panel into the desktop shell.
- Added a source-level forbidden-control regression.
- Kept readiness diagnostics separated from command history and control
  diagnostics.
- Next reassessment: pause the current tranche and compile the stable longer
  term plan list before picking the next implementation lane.

## Acceptance Criteria

- Desktop renders runtime readiness records from typed DTOs.
- Blockers and repair hints are visible without exposing raw payloads,
  credentials, or environment data.
- No approve, retry, cancel, execute, repair, artifact download, PTY, or stream
  controls appear.
- The next lane is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/261-define-disposable-readiness-panel-boundary.md`
- `docs/roadmaps/g01/batch-cards/262-add-read-only-runtime-readiness-panel.md`
- `docs/roadmaps/g01/batch-cards/263-wire-readiness-panel-into-desktop-shell.md`
- `docs/roadmaps/g01/batch-cards/264-add-forbidden-readiness-control-regression.md`
- `docs/roadmaps/g01/batch-cards/265-verify-readiness-panel-and-reassess.md`
