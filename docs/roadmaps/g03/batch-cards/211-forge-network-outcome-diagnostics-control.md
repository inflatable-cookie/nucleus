# 211 Forge Network Outcome Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../059-stopped-forge-network-outcome-persistence-control.md`

## Purpose

Expose read-only diagnostics and control DTOs for stopped forge network outcome
persistence records.

## Acceptance Criteria

- [x] Diagnostics count outcome, stopped-recorded, failed, blocked,
  repair-required, duplicate no-op, persistence-blocked, blocker, and evidence
  refs.
- [x] Control DTOs carry sanitized counts only.
- [x] Control DTOs expose no credential, provider-call, forge-effect,
  provider-effect, callback, interruption, recovery, task-mutation, or raw
  payload authority.
