# 019 Convergence Stopped Runner Command Adapter

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Define a stopped command-adapter boundary over persisted Convergence runner
evidence without integrating a real Convergence backend or executing
publication effects.

## Governing Refs

- `docs/roadmaps/g03/018-convergence-runner-evidence-persistence.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/002-harness-adapter-contract.md`

## Goals

- [ ] Describe the command-adapter request shape over persisted evidence.
- [ ] Preserve idempotency and provider-stage refs.
- [ ] Add diagnostics for runnable, blocked, duplicate, and unsupported states.
- [ ] Keep all execution effects false.

## Execution Plan

- [ ] Stopped command-adapter batch.
- [ ] Diagnostics batch.
- [ ] Closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/070-convergence-stopped-runner-command-adapter.md`

Planned cards:

- `batch-cards/071-convergence-stopped-runner-command-diagnostics.md`
- `batch-cards/072-convergence-stopped-runner-command-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Command-adapter records derive only from persisted reviewable evidence.
- [ ] Blocked or duplicate evidence persistence cannot produce runnable
  adapter records.
- [ ] The adapter remains a stopped proof, not a backend integration.
- [ ] No runner invocation, provider handoff, snapshot creation, publish,
  publication review, provider write, task mutation, callback, interruption,
  recovery, or raw-output effect is added.
