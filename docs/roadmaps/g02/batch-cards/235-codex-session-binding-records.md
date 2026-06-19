# 235 Codex Session Binding Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../054-codex-live-event-acceptance.md`

## Purpose

Add durable record types for Codex session binding and ingestion source
identity.

## Scope

- Preserve Nucleus session id, adapter instance, provider session/thread ids,
  runtime ownership, and binding confidence.
- Add decoded-frame ingestion source identity without opening transport.
- Keep records in focused modules, not a large `lib.rs`.
- Do not spawn Codex.

## Acceptance Criteria

- Session binding records are provider-specific but Nucleus-id authoritative.
- Ingestion source records can be referenced by later event and receipt paths.
- Tests prove missing provider ids and replacement-thread recovery are explicit.

## Result

`nucleus-server` now has focused Codex session binding and ingestion source
records under `codex_supervision/session_binding.rs`.

The records preserve Nucleus session authority, provider refs, binding
confidence, recovery state, decoded-frame source identity, transport sequence,
and metadata-only raw payload policy. They do not spawn Codex, open transport,
append orchestration events, or mutate task state.

Targeted binding tests pass.

## Validation

- `cargo check --workspace`
- targeted crate tests
- `effigy qa:docs`
- `git diff --check`

## Stop Conditions

- Stop if the binding record would make provider ids authoritative over
  Nucleus ids.
