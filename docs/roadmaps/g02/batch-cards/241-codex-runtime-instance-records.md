# 241 Codex Runtime Instance Records

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../055-codex-process-and-transport-acceptance.md`

## Purpose

Add Codex owned-runtime instance records before process spawn behavior expands.

## Scope

- Name runtime instance id, host id, adapter instance, process owner, binary,
  endpoint, payload retention policy, and lifecycle state.
- Keep records descriptive and reference-only.
- Do not spawn Codex.

## Acceptance Criteria

- Runtime instance identity is stable and Nucleus-owned.
- Host and adapter refs remain explicit.
- Payload retention defaults to metadata/evidence refs, not raw provider
  payloads.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if runtime instance records require live process handles.
