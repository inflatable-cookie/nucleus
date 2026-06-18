# 141 Codex Wait State Task Linkage

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../032-codex-task-runtime-admission-bridge.md`

## Purpose

Link Codex wait states to task work units.

## Scope

- Attach approval/user-input waits to work-unit refs.
- Preserve task and session refs.
- Keep wait state client-visible and read-only.

## Acceptance Criteria

- [x] Wait states identify their task work unit.
- [x] Approval requirements do not imply automatic approval.
- [x] Recovery after wait is represented.

## Result

Added `CodexTaskRuntimeWaitLink` and linkage from server-owned Codex wait
states to task work units. Approval remains non-automatic.

## Validation

- `cargo test -p nucleus-server codex_wait`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if wait handling needs provider execution.
