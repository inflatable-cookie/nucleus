# 241 Codex Runtime Instance Records

Status: completed
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

## Result

`nucleus-server` now has pre-spawn Codex runtime instance records under
`codex_supervision/runtime_instance.rs`.

The records preserve runtime instance id, host id, adapter identity,
Nucleus-owned process ownership, binary metadata, endpoint label, payload
retention policy, lifecycle state, and evidence refs. They do not store process
handles, spawn Codex, or open stdio.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if runtime instance records require live process handles.
