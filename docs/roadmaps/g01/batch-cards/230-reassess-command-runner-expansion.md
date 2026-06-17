# 230 Reassess Command Runner Expansion

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess the command runner after the real read-only smoke path is wired.

## Scope

- Check safety gates.
- Check evidence persistence.
- Decide whether to expand command inputs, desktop controls, or terminal
  integration next.

## Out Of Scope

- Implementing the next expansion.
- Write-enabled commands.
- Remote execution.

## Promotion Targets

- `docs/roadmaps/g01`

## Acceptance Criteria

- Next command runner lane is explicit.
- Remaining blockers are visible.
- No expansion proceeds without contract coverage.

## Closeout

The real smoke path is stable enough for the next lane, but the next lane
should not accept arbitrary command strings yet.

Next command-runner work should define a read-only command request/admission
shape through the server control API, including DTOs, policy rejection shape,
sanitized response fields, and clear limits on executable/argv input.
