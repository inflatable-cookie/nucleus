# 204 Long Term Plan Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../044-scm-workflow-closeout-and-next-phase-selection.md`

## Purpose

Rebaseline the long-term plan after SCM workflow closeout.

## Scope

- Update completed/current/planned workflow sequences.
- Update roadmap coverage under affected phases.
- Keep generation rollover discussion grounded in file state.

## Acceptance Criteria

- `docs/roadmaps/long-term-plan.md` reflects current implementation state.
- Roadmap indexes point at the chosen next phase.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if rebaseline would hide unresolved SCM gaps.

## Result

Long-term and gap indexes now show SCM as a closed record/prep runway with
provider execution still missing. The next runway is code-health repair.
