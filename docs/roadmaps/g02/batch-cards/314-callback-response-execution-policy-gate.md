# 314 Callback Response Execution Policy Gate

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../070-codex-callback-response-execution-gate.md`

## Purpose

Define the server policy gate that decides whether a Codex callback response may
enter an execution path.

## Scope

- Name required callback request, callback response, task work, runtime,
  adapter, host, and operator evidence.
- Require callback kind and response shape evidence.
- Keep tool exposure behind portal-tool and adapter capability policy.
- Block task completion, review acceptance, cancellation, resume, SCM mutation,
  raw provider material retention, and automatic callback answering.
- Add compile-time records and tests only.

## Acceptance Criteria

- [x] Gate records compile in focused modules.
- [x] Tests cover accepted and blocked decisions.
- [x] Records do not execute provider writes.
- [x] Records do not grant task mutation or review authority.
- [x] Records do not retain raw callback prompt or response material.

## Validation

- targeted server tests
- `cargo check --workspace`
