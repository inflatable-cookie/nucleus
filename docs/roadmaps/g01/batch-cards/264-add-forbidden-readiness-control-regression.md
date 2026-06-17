# 264 Add Forbidden Readiness Control Regression

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prevent the readiness panel from growing command or repair controls by
accident.

## Scope

- Add a source-level regression test.
- Forbid approve, retry, cancel, execute, repair, download, PTY, stream, and
  direct command submission vocabulary.

## Out Of Scope

- Browser automation.
- Final UI assertions.

## Promotion Targets

- `apps/desktop/src-tauri/src/lib.rs`

## Acceptance Criteria

- Tests fail if the readiness panel exposes forbidden runtime controls.

## Outcome

Added a desktop source regression that forbids command, repair, PTY, stream,
download, retry, cancel, approval, and direct submission vocabulary in the
readiness panel.
