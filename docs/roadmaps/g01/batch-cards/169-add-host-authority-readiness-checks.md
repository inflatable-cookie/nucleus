# 169 Add Host Authority Readiness Checks

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add first readiness checks for whether a host owns a requested authority
domain.

## Scope

- Check assigned authority domains.
- Return explicit blocked/ready readiness.
- Keep checks transport-free.

## Out Of Scope

- Auth.
- Remote connection management.
- Persistence.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Readiness checks compile.
- Tests distinguish connected host from authoritative host.
- Execution authority can be checked as a domain.

## Closeout

- Added `HostAuthorityReadiness` and `HostAuthorityReadinessStatus`.
- Tests distinguish connected host, different authoritative host, mutation
  denied, and ready authority states.
