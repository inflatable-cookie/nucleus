# 024 Local Process Supervision Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the local process supervision contract needed before Nucleus can spawn
even read-only host commands.

## Scope

- Promote structured invocation records beyond the temporary `nucleus-server`
  skeleton shape.
- Define timeout and cancellation semantics for local child processes.
- Define environment construction and output bounding rules.
- Define the sandbox limits that must be honest for the first host-spawn slice.
- Keep command evidence persistence and query behavior as prerequisites.

## Out Of Scope

- Implementing host process spawning.
- Network, secret, destructive, SCM mutation, or provider lifecycle commands.
- PTY streaming.
- Raw artifact payload backend.
- Desktop UI.

## Decisions

- The existing gate-only runner is useful but not execution.
- Host process spawning should not start until timeout, cancellation, env,
  output, and sandbox behavior are contract-backed.
- The next code slice should add durable invocation/supervision vocabulary
  before any real child process starts.

## Execution Plan

- [x] Draft local process supervision contract.
- [x] Promote structured command invocation records.
- [x] Add process supervision readiness types.
- [x] Reassess first host-spawn implementation slice.

## Acceptance Criteria

- [x] Host process spawning prerequisites are explicit.
- [x] Structured invocation records are separate from shell strings.
- [x] Timeout, cancellation, environment, output, and sandbox limits are named.
- [x] No child process spawning is introduced in this lane before reassessment.

## Cards

- `docs/roadmaps/g01/batch-cards/156-draft-local-process-supervision-contract.md`
- `docs/roadmaps/g01/batch-cards/157-promote-structured-command-invocation-records.md`
- `docs/roadmaps/g01/batch-cards/158-add-process-supervision-readiness-types.md`
- `docs/roadmaps/g01/batch-cards/159-reassess-first-host-spawn-slice.md`

## Closeout

Host process spawning remains blocked. The next lane is process supervisor
module and event boundary preparation, still without child process execution.
