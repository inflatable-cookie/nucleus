# 144 Compile Server Runtime Control Surface

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Define the next runnable `nucleusd` control surface before adding more binary
commands.

## Scope

- Decide which existing server control queries should be callable from
  `nucleusd`.
- Decide output format posture for smoke and operator use.
- Decide whether command submission belongs in the first CLI surface or stays
  behind tests.
- Keep networking and daemon lifecycle out unless a contract is promoted.

## Out Of Scope

- HTTP, WebSocket, or socket transport.
- Background workers.
- Provider processes.
- Command execution.
- Desktop UI.

## Promotion Targets

- `docs/roadmaps/g01/021-nucleusd-local-server-runtime.md`
- `docs/contracts/007-server-boundary-contract.md`
- `apps/nucleusd/README.md`

## Acceptance Criteria

- [x] The next server binary command is explicit.
- [x] Output format and state path behavior are explicit.
- [x] Any unsupported runtime behavior remains visible.

## Result

The next server binary command is `nucleusd query <projects|tasks|workspaces>`.
It uses the existing local state path behavior and prints deterministic text
records. It stays local-only and does not open transport or execute runtime
work.
