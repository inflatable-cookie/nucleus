# 207 Atomic Materialization And Typed Errors

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../044-persistence-correctness-hardening.md`
Auto-start next card: no

## Objective

Crash-safe projection file writes and structured store errors.

## Steps

- temp file + `sync_all` + rename in
  `accepted_memory_projection_file_materialization.rs`
- give `LocalStoreError` `Display` + `std::error::Error`; split
  `BackendRejected { reason }` into busy / constraint / corruption variants
  so callers can retry busy
- stop flattening rusqlite errors to strings in `sqlite_error`
- revision ids: make unique per write (counter/uuid) instead of derived from
  command id, or document idempotency semantics explicitly in contract 008

## Acceptance

- [ ] no bare `fs::write` on projection authority files
- [ ] busy errors distinguishable and retried where safe
- [ ] revision-id semantics decided and recorded

## Validation

- `cargo test -p nucleus-local-store`
- `cargo test -p nucleus-server`

## Stop Conditions

- stop if revision-id change ripples into DTO wire shapes; surface first
