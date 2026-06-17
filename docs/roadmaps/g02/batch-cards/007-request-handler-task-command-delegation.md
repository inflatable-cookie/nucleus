# 007 Request Handler Task Command Delegation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Make request-handler task commands delegate mutation to the engine task command
service.

## Scope

- Server command DTO to engine command mapping.
- Engine result to server command receipt mapping.
- Preserve disposable desktop and `nucleusd` proof behavior.
- Keep request-handler code as adaptation and receipt formatting.

## Out Of Scope

- New client protocol.
- Timeline UI.
- Provider runtime.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- [x] Request-handler modules no longer own the core task mutation branch.
- [x] Existing task command tests still pass.
- [x] No new dependency from `nucleus-engine` to `nucleus-server` appears.

## Stop Conditions

- Delegation makes server/local-store adapter assumptions leak into
  `nucleus-engine`.

## Outcome

Replaced request-handler task mutation with server DTO mapping,
`ServerTaskCommandRepository`, and engine result/error mapping.
