# 231 Codex Runtime Code Audit

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../053-harness-runtime-rebaseline.md`

## Purpose

Audit current Codex runtime code against harness runtime contracts.

## Scope

- Inspect Codex adapter, supervision, wait-state, task runtime, and receipt
  modules.
- Identify what is record-only, compile-only, proof runtime, or ready for the
  next lane.
- Do not add provider behavior.

## Acceptance Criteria

- Current Codex runtime state is accurately documented.
- Drift between docs and code is recorded.

## Validation

- `cargo check --workspace`
- `effigy qa:docs`
- `git diff --check`

## Stop Conditions

- Stop if current code has safety drift that should block runtime work.
