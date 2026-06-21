# 029 Convergence Local Snap Execution Preflight

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Define the preflight gate for a future `converge snap` local command execution
without spawning the process.

## Governing Refs

- `docs/roadmaps/g03/028-convergence-local-snap-runner-replay-boundary.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Admit local snap execution only from replayed local snap runner replay
  records.
- [ ] Require explicit operator confirmation, executable readiness, workspace
  readiness, and authority refs.
- [ ] Report blocked, duplicate, unsupported, and ready preflight states.
- [ ] Keep process spawn, actual `converge snap`, object upload, publication,
  lane sync, and provider writes false.

## Execution Plan

- [ ] Execution preflight records batch.
- [ ] Execution preflight diagnostics batch.
- [ ] Closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/100-convergence-local-snap-execution-preflight-records.md`

Planned cards:

- `batch-cards/101-convergence-local-snap-execution-preflight-diagnostics.md`
- `batch-cards/102-convergence-local-snap-execution-preflight-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Replayed local snap runner replay records can produce ready preflight
  records.
- [ ] Missing operator confirmation, executable readiness, workspace readiness,
  or authority refs blocks preflight.
- [ ] Duplicate and unsupported replay records remain inspectable but cannot
  become ready preflight.
- [ ] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, provider write, task mutation, callback, interruption, recovery,
  or raw output effect is added.
