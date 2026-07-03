# 528 Disposable Planning Research UI Proof Boundary

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../121-disposable-planning-research-ui-proof.md`

## Purpose

Select the smallest disposable UI proof boundary for reading planning sessions,
memory proposals, and research run briefs together.

## Work

- [x] Inspect the existing app/client shape and root Effigy tasks.
- [x] Decide whether the first proof should use the existing desktop app,
  a server-rendered/static proof, or a CLI-generated inspection artifact.
- [x] Define no-effect rules for the proof surface.
- [x] Capture the decision in the roadmap before implementation.

## Acceptance Criteria

- [x] The proof boundary is explicit.
- [x] The proof uses existing server read models.
- [x] Mutation controls, provider execution, research execution, memory
  acceptance, planning import apply/review, SCM/forge effects, and final UI
  design are deferred.

## Evidence

- Existing root Effigy selectors already route desktop launch and checks:
  `desktop:dev`, `desktop:web:dev`, `desktop:check`, and `desktop:build`.
- Existing desktop command path routes through `submit_control_envelope`.
- Selected boundary: extend the existing disposable desktop proof shell.
