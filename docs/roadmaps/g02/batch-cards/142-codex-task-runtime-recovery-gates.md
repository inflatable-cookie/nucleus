# 142 Codex Task Runtime Recovery Gates

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../032-codex-task-runtime-admission-bridge.md`

## Purpose

Represent cancellation, resume, and recovery blockers for Codex task work.

## Scope

- Add recovery gate records or states.
- Preserve terminal and non-terminal distinctions.
- Avoid retry execution.

## Acceptance Criteria

- Cancellation and resume states are explicit.
- Recovery-required states carry evidence refs.
- No retry side effect runs.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if retry behavior needs product approval.
