# 497 Planning Projection Import Boundary Selection

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../117-planning-projection-import-admission.md`

## Purpose

Select the first planning projection import/admission boundary.

## Work

- [x] Define the import candidate, admission, and conflict-staging vocabulary.
- [x] Name the authorities that remain blocked.
- [x] Record why projection files are not active planning authority.
- [x] Update architecture notes with the selected boundary.

## Acceptance Criteria

- [x] The selected boundary distinguishes scan, admission, conflict staging,
  and apply.
- [x] The boundary blocks active planning mutation, task promotion, provider
  execution, SCM/forge mutation, and UI behavior.
- [x] The next card can implement candidate records without fresh planning
  decisions.

## Stop Conditions

- The boundary requires semantic merge resolution.
- The boundary requires treating repo files as immediately authoritative.

## Decision

Selected boundary:

- scan projected files into read-only import candidates
- admit reviewed candidates into stopped import records
- stage semantic conflicts as review records
- defer apply, active planning mutation, task promotion, task creation, agent
  scheduling, provider execution, SCM/forge mutation, and UI behavior

Projected planning files remain shared management artifacts until server-owned
admission and later apply authority make them active. A valid TOML file is not
itself planning authority.
