# 209 Forge Network Outcome Persistence Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../059-stopped-forge-network-outcome-persistence-control.md`

## Purpose

Define the stopped forge network outcome persistence input, record, set,
status, blocker, diagnostics, and control DTO types.

## Acceptance Criteria

- [x] Types carry request, receipt, preflight, admission, task, repo, operator,
  provider, credential-ref, idempotency, retry, recovery, runtime receipt, and
  evidence refs.
- [x] Types represent stopped recorded, failed, blocked, repair-required, and
  duplicate no-op outcomes.
- [x] Types carry explicit no-effect flags for credential resolution, provider
  calls, forge/provider effects, callbacks, interruption, recovery, task
  mutation, and raw provider payload retention.
- [x] Public exports are available through `nucleus-server`.
