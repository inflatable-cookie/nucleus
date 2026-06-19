# 066 Task Backed Workflow Hardening

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Harden the task-backed agent workflow before running a real Codex provider
write.

Roadmap `065` completed the stopped-by-default Codex `turn/start` transport
executor boundary. The operator selected product workflow hardening before
direct provider testing. This lane removes proof-only task-agent state paths
and makes the read model depend on durable task-history source records.

## Governing Refs

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/065-codex-turn-start-transport-executor-handoff.md`

## Goals

- [x] Persist task-agent work-unit source records in server-owned task history.
- [x] Read task work progress and task-agent diagnostics from persisted source
      records.
- [x] Add explicit runtime/review transition validation for task-agent source
      records.
- [x] Clarify repo-backed projection policy for task-agent workflow state.
- [x] Leave direct Codex provider writes blocked until operator confirmation.

## Non-Goals

- Do not run the Codex real-write smoke in this lane.
- Do not mutate task completion from provider observations.
- Do not retain raw provider payloads, stdout, stderr, or terminal streams.
- Do not add UI panels.
- Do not build a general event-sourced task store beyond the narrowed task
  history source-record path.

## Execution Plan

- [x] Persistence batch: add the task-history domain path and a sanitized
      task-agent source-record codec.
- [x] Query batch: route task work progress and task-agent diagnostics through
      persisted source records.
- [x] Transition batch: add runtime/review transition checks before persisted
      source records can advance work-unit state.
- [x] Projection policy batch: define what is durable database state, what is
      repo-backed projection state, and how stale projections are repaired.
- [x] Closeout batch: validate the hardening lane and select either direct
      Codex testing or the next product workflow hardening target.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/298-task-agent-source-record-persistence.md`
- `batch-cards/299-task-work-progress-query-from-state.md`
- `batch-cards/300-task-agent-transition-validation.md`
- `batch-cards/301-task-backed-hardening-closeout.md`

## Acceptance Criteria

- [x] Task-agent work-unit source records survive backend reopen.
- [x] Persisted task-agent source records reject raw provider material.
- [x] Task work progress query surfaces persisted records without client
      mutation authority.
- [x] Task-agent diagnostics query surfaces persisted records without provider
      execution authority.
- [x] Runtime/review source-record transitions reject invalid jumps.
- [x] Docs name the remaining projection-policy and provider-write gates.
- [x] Validation passes or blockers are recorded.

## Gate

Direct Codex provider testing remains blocked until the operator explicitly
confirms the real-write smoke may run.
