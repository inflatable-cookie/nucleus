# Persistence Correctness Hardening

Date: 2026-07-17
Lane: g04 persistence correctness hardening (closeout)

## Outcome

- revision CAS is atomic: check + write run inside `BEGIN IMMEDIATE`, so two
  `Exact` writers cannot both succeed — across threads, connections, or
  processes
- one shared connection per backend (`Arc<Mutex<Connection>>`): schema and
  pragmas run once, not per operation; WAL, 5s busy timeout, synchronous
  NORMAL, foreign keys on
- monotonic `seq` column on all record tables, assigned inside the CAS
  transaction; event-journal replay uses insertion order via
  `list_in_insertion_order()`, replacing lexicographic event-id sorting;
  legacy databases migrate on open with order backfilled from rowid
- fixed a projection test that had the lexicographic-order bug baked into
  its cursor assertion
- accepted-memory projection files write atomically (temp + fsync + rename)
- `LocalStoreError` implements `Display`/`Error`; SQLite busy/locked maps to
  a retryable `BackendBusy` variant
- revision-id semantics recorded in contract 008: command-derived ids,
  idempotent by replay, uniqueness guaranteed by CAS

## Evidence

- concurrent-writer test: exactly one `Exact(rev:1)` winner across two
  backends on separate connections
- append-order replay test with ids whose lexicographic order contradicts
  append order
- legacy-schema migration test preserves order via rowid backfill
- `cargo test --workspace` passes; CI green on GitHub (first run)

## Next

Milestone 045: admission vocabulary consolidation (shared NoEffects /
evidence / admission framework, typed_response collapse, tautological test
pruning).
