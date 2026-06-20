# 332 Durable Provider Executor Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../073-codex-provider-durable-executor-gate.md`

## Purpose

Expose read-only diagnostics for durable provider executor command state.

## Scope

- Add diagnostics for command, status, write-attempt, receipt, and evidence
  refs.
- Route diagnostics through the Codex provider diagnostics surface.
- Keep diagnostics sanitized and authority-free.

## Acceptance Criteria

- [x] Diagnostics expose command lifecycle state.
- [x] Diagnostics do not expose raw provider material.
- [x] Diagnostics do not grant provider write, task, review, callback,
      interruption, recovery, or SCM authority.

## Validation

- `cargo test -p nucleus-server durable_provider_executor_diagnostics -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
