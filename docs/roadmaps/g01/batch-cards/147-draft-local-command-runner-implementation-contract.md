# 147 Draft Local Command Runner Implementation Contract

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first safe local command runner implementation contract.

## Scope

- Define the first executable command subset.
- Define required policy gates before execution.
- Define working-directory validation.
- Define output capture and sanitized evidence rules.
- Define timeout and cancellation posture.
- Define explicitly blocked command scopes.

## Out Of Scope

- Implementing the runner.
- Spawning processes.
- Provider processes.
- PTY execution.
- Network-enabled commands.
- Secret access.
- Destructive commands.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/roadmaps/g01/022-command-runner-execution-readiness.md`

## Acceptance Criteria

- [x] First local runner subset is explicit.
- [x] Execution blockers are explicit.
- [x] Evidence and output retention rules are explicit.
- [x] Next implementation card is narrow.

## Result

The local command runner implementation contract is promoted into the server
and storage contracts. The first executable subset is structured argv,
read-only inspection, low risk, local-only, no shell, no network, no secrets,
bounded output, timeout required, and sanitized evidence only.

Next card: `148-add-command-runner-storage-readiness.md`.
