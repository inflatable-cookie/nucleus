# 053 Forge Pull Request Runner Proof

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Implement the first stopped forge pull-request runner proof from existing
admitted pull-request execution preflight records.

This lane may prepare sanitized provider request records only. It must not call
forge APIs, run provider writes, create pull requests, answer callbacks,
interrupt/recover harness sessions, mutate task state, retain raw output, or
expand UI/remote transport.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/008-forge-pull-request-execution-admission.md`
- `docs/roadmaps/g03/052-git-push-runner-proof.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add stopped PR runner authority from existing ready preflight records.
- [x] Add a constrained provider request adapter.
- [x] Persist sanitized PR runner outcomes and evidence.
- [x] Expose read-only diagnostics/control DTOs for PR runner state.
- [x] Keep warning-sized files split when touched.

## Execution Plan

- [x] PR runner authority records.
- [x] Provider request adapter.
- [x] Sanitized outcome persistence.
- [x] Diagnostics/control integration.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/178-forge-pull-request-runner-authority-records.md`
- `batch-cards/179-forge-pull-request-runner-request-adapter.md`
- `batch-cards/180-forge-pull-request-runner-outcome-persistence.md`
- `batch-cards/181-forge-pull-request-runner-diagnostics-control.md`
- `batch-cards/182-forge-pull-request-runner-validation-closeout.md`

## Acceptance Criteria

- [x] Runner request preparation is admitted only from existing ready preflight
  records and explicit operator PR intent.
- [x] Provider request records retain sanitized refs and text-source metadata,
  not title/body text.
- [x] Adapter prepares request data without shell passthrough or provider I/O.
- [x] Outcomes retain sanitized ids, statuses, counts, forge refs, branch refs,
  and evidence refs only.
- [x] Pull-request creation, forge effects, provider effects, callbacks,
  interruption, recovery, task mutation, UI/remote transport expansion, and
  raw-output retention remain blocked.
- [x] `effigy doctor` remains error-free or a blocker is recorded.

## Closeout

The stopped PR runner proof now reaches sanitized persistence and read-only
control DTOs from existing admitted PR execution preflight records.

Next lane:

- run a Git/forge runner health and boundary rebaseline

Reason:

- branch/worktree, commit, push, and stopped PR request-preparation proofs now
  share the same authority, adapter, persistence, and diagnostics shape
- real forge/provider writes need a fresh boundary check before implementation
- warning pressure should be rechecked before adding provider-auth and network
  execution behavior
