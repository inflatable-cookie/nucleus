# 231 Compile Read-Only Command Control API Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compile the first control API shape for read-only command requests.

## Scope

- Name request fields needed to enter the spawn helper.
- Name response fields safe for clients.
- Define rejection surfaces for unsupported scope, shell passthrough, missing
  readiness, invalid working directory, timeout, and unbounded output.
- Keep raw output out of the control response.

## Out Of Scope

- Implementing DTOs.
- Accepting arbitrary CLI input.
- Desktop UI.
- Write-enabled commands.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g01/040-read-only-command-request-control-api.md`

## Acceptance Criteria

- Contract names the read-only command request/admission boundary.
- Safe response fields are explicit.
- Implementation cards remain bounded.

## Closeout

Promoted the read-only command request/admission boundary into the server
contract.

The control request is structured executable plus argv, working directory,
timeout, output byte limits, project id, execution host id, and optional display
text. The response is sanitized evidence metadata only.
