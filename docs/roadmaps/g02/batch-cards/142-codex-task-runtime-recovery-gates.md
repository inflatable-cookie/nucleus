# 142 Codex Task Runtime Recovery Gates

Status: completed
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

- [x] Cancellation and resume states are explicit.
- [x] Recovery-required states carry evidence refs.
- [x] No retry side effect runs.

## Result

Added `CodexTaskRuntimeRecoveryGate` and recovery states for cancellation,
resume blockers, and recovery-required cases. Retry execution is explicitly
disabled.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if retry behavior needs product approval.
