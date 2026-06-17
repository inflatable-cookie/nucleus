# 039 G02 Roadmap Suite Normalization

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../012-health-and-authority-surface-reset.md`

## Purpose

Normalize G02's next runway suite so continuation no longer depends on
ad-hoc lane selection.

## Scope

- Add planned G02 milestone roadmaps for the next major lanes.
- Update `docs/roadmaps/README.md`.
- Update `docs/roadmaps/g02/README.md`.
- Update `docs/roadmaps/long-term-plan.md`.
- Keep only one active `## Next Task` pointer.

## Acceptance Criteria

- G02 has one active milestone and a clear planned sequence.
- Planned milestones name gates and governing refs.
- Future live provider, client transport, SCM, and steward work has a visible
  order.
- No batch cards are created for planned milestones before their gates are met.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if the planned sequence conflicts with current architecture contracts.

## Outcome

Completed 2026-06-17.

The G02 front doors now agree that `012` is the only active milestone. The
planned runway now flows through client protocol, authority-map records, live
Codex supervision, task-backed work units, management projection file IO, SCM
workflows, and steward/native harness tools.

The root roadmap, G02 front door, planned milestone statuses, and long-term
plan all carry the same order. Planned milestones still have no new batch cards
before their gates are met.
