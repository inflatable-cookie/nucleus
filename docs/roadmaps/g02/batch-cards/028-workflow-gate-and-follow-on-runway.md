# 028 Workflow Gate And Follow-On Runway

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../008-scm-forge-driver-runway.md`

## Purpose

Close the SCM/forge driver runway by defining the gate for later branch,
worktree, publication, and change-request implementation.

This card should not implement mutation. It should make the next runtime work
harder to start accidentally.

## Scope

- Update `../008-scm-forge-driver-runway.md` with the completed outcome.
- Document the ready gate for real SCM mutations.
- Name the evidence that mutation work needs: management projection export,
  checkpoint/diff refs, driver capabilities, host authority, command/effect
  receipts, and policy scope.
- Identify separate follow-on work for Git branch/worktree sessions,
  Convergence publication/gate flows, and forge change-request workflows.
- Advance `docs/roadmaps/README.md` to the next bounded task only after the
  runway is closed.

## Acceptance Criteria

- The roadmap states what must be true before Nucleus mutates branches,
  worktrees, publications, reviews, or change requests.
- Git-specific branch/worktree work and Convergence publication/gate work are
  separated.
- Forge change-request behavior is not conflated with SCM capture/publish
  behavior.
- The next task pointer names the next real milestone or stop point.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if runtime mutation implementation starts during this card.
- Stop if the next milestone cannot be named from existing roadmap authority.

## Outcome

Closed `../008-scm-forge-driver-runway.md` with an explicit mutation ready
gate and separated follow-on runways for Git branch/worktree sessions,
Convergence publication/gate flows, and forge change-request workflows.
