# 075 Codex Durable Dispatch Invocation Gate

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Move from durable dispatch records to an explicitly admitted server-owned
executor invocation path.

The previous lane can select durable commands, admit dispatch, link sanitized
live outcomes, and expose diagnostics. This lane should define the final gate
between an accepted durable dispatch admission and an actual executor call.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/074-codex-durable-executor-dispatch-gate.md`

## Goals

- [x] Define invocation preflight records for accepted durable dispatch
      admissions.
- [x] Define invocation request records that preserve dispatch, provider,
      runtime, write-attempt, and idempotency identity.
- [x] Bridge invocation requests to the existing Codex live executor boundary
      without bypassing operator confirmation.
- [x] Persist or link invocation outcomes through existing sanitized outcome,
      receipt, and durable status records.
- [x] Keep unattended background execution, task mutation, review acceptance,
      callback answering, interruption, recovery promotion, SCM mutation, and
      raw provider material retention blocked.

## Non-Goals

- Do not add UI controls.
- Do not add unattended provider execution.
- Do not broaden the provider method set beyond already admitted durable
  commands.
- Do not persist raw provider payloads, streams, stdout, stderr, prompts, or
  callback material.
- Do not mark tasks complete, accept review, answer callbacks, interrupt,
  resume, promote replacement threads, or mutate SCM state.

## Execution Plan

- [x] Preflight batch: prove accepted dispatch admissions are invocable without
      granting authority.
- [x] Request batch: define deterministic invocation request records.
- [x] Handoff batch: bridge accepted requests to the Codex live executor
      boundary.
- [x] Outcome batch: connect invocation outcomes to durable dispatch linkage and
      status records.
- [x] Diagnostics/closeout batch: expose invocation progress read models,
      validate, and pick the next runtime step.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/339-durable-dispatch-invocation-preflight.md`
- `batch-cards/340-durable-dispatch-invocation-request-records.md`
- `batch-cards/341-durable-dispatch-executor-handoff.md`
- `batch-cards/342-durable-dispatch-outcome-persistence.md`

## Acceptance Criteria

- [x] Accepted durable dispatch admissions can pass invocation preflight.
- [x] Invocation request records are deterministic and idempotent.
- [x] Executor handoff remains explicitly operator-gated.
- [x] Invocation outcomes link to sanitized live executor outcomes and durable
      status records.
- [x] Diagnostics are read-only and authority-free.
- [x] Validation passes or blockers are recorded.
