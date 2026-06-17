# 037 Error God File Module Splits

Status: ready
Owner: Tom
Updated: 2026-06-17
Milestone: `../012-health-and-authority-surface-reset.md`

## Purpose

Split the current error-level god files into smaller modules without changing
behavior.

## Scope

- Split `crates/nucleus-agent-protocol/src/codex.rs`.
- Split `crates/nucleus-engine/src/task_commands.rs`.
- Split `crates/nucleus-server/src/control_envelope_dto/response.rs`.
- Split `crates/nucleus-server/src/request_handler/tests.rs`.
- Keep `lib.rs` and `mod.rs` files as front doors only.
- Do not add new runtime behavior.

## Acceptance Criteria

- Error-level god-file findings are removed for the four files.
- Existing public exports remain available where current callers need them.
- Targeted tests still pass.
- No unrelated warning-level files are refactored in this card unless needed
  by the split.

## Validation

- `effigy doctor`
- `cargo test -p nucleus-agent-protocol`
- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-server`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if a split requires public API redesign rather than mechanical module
  movement.
- Stop if behavior changes become necessary to compile.

