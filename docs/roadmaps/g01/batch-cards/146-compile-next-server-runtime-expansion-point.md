# 146 Compile Next Server Runtime Expansion Point

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Choose the next server runtime batch after the local `nucleusd` smoke/query
surface.

## Scope

- Compare local control transport, event replay/subscription, command runner,
  and project/tooling integration as next server work.
- Keep disposable desktop UI out of the decision.
- Identify the narrow next executable server card.

## Out Of Scope

- Implementing the chosen batch.
- Network listener.
- Provider process lifecycle.
- Command execution.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/007-server-boundary-contract.md` if a missing runtime gate is
  found

## Acceptance Criteria

- [x] Next server expansion point is explicit.
- [x] Any missing contract is visible.
- [x] Next ready card is narrow enough to execute.

## Result

The next server expansion point is command runner execution readiness, because
it is the first major server-owned path toward doing real project work.

Process execution itself is still blocked by contract gaps: runtime strategy,
sandbox backend, working-directory checks, output capture, artifact retention,
and evidence publication need an implementation contract before code spawns a
process.

Next ready card: `147-draft-local-command-runner-implementation-contract.md`.
