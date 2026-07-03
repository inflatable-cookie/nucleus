# 121 Disposable Planning Research UI Proof

Status: completed
Owner: Tom
Updated: 2026-07-03

## Purpose

Create a disposable, non-authoritative UI proof for inspecting the existing
read-only planning, memory, and research server read models together.

This lane is explicitly not final UI design. It exists to test whether the
server shapes are useful before adding review commands, import apply/review,
research execution, or heavier plugin/editor surfaces.

## Governing Refs

- `docs/architecture/client-server-authority-model.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/roadmaps/g03/118-structured-planning-domain-foundation.md`
- `docs/roadmaps/g03/119-planning-memory-proposal-foundation.md`
- `docs/roadmaps/g03/120-deep-research-run-brief-foundation.md`

## Goals

- [x] Select the smallest proof boundary for reading planning sessions, memory
  proposals, and research run briefs in one client surface.
- [x] Keep the proof disposable and server-led.
- [x] Reuse existing server query paths instead of inventing a parallel client
  state model.
- [x] Avoid committing to final UI design, panel layout, editor integration,
  plugin runtime, task mutation, memory acceptance, or research execution.

## Execution Plan

- [x] Batch 1: select the disposable UI proof boundary and no-effect rules.
- [x] Batch 2: add one root Effigy selector for launching the current proof
  client/server workflow if the existing app shape supports it.
- [x] Batch 3: expose read-only planning, memory, and research summaries in the
  proof surface without mutation controls.
- [x] Batch 4: validate the proof surface and choose the next lane.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/530-disposable-planning-memory-research-summary-surface.md`
- `batch-cards/529-disposable-ui-root-effigy-launch.md`
- `batch-cards/528-disposable-planning-research-ui-proof-boundary.md`
- `batch-cards/531-disposable-ui-proof-validation-next-lane.md`

## Acceptance Criteria

- [x] The proof surface is read-only.
- [x] The server remains the source of planning, memory, and research data.
- [x] No provider execution, task mutation, accepted memory mutation, planning
  import/apply, research execution, browser automation, source retrieval, SCM
  mutation, forge mutation, or final UI commitment is introduced.

## Boundary Decision

Selected proof:

- existing Tauri/Svelte desktop proof shell

Rationale:

- root Effigy selectors already expose `desktop:dev`, `desktop:web:dev`,
  `desktop:check`, and `desktop:build`
- the Tauri command path already submits serialized control envelopes into the
  Rust server adapter
- the server already owns read-only planning sessions, memory proposals, and
  research run brief projections
- a static artifact or CLI-only proof would not validate the desktop
  client/server shape

Rules:

- client state is limited to loading, errors, refresh intent, and display
  selection
- TypeScript only builds control envelopes, parses DTOs, and renders summaries
- Rust/server state remains authoritative
- the proof may be discarded when final UI design starts

## Stop Conditions

- The work requires final UI direction beyond a disposable proof.
- The work requires designing a plugin runtime, code editor, or panel layout
  system.
- The work requires accepting memory, applying planning imports, creating
  tasks, or executing research.
