# 205 Transactional CAS And Connection Hygiene

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../044-persistence-correctness-hardening.md`
Auto-start next card: no

## Objective

Make revision compare-and-swap atomic and fix SQLite connection handling.

## Steps

- wrap revision check + upsert in one transaction (`BEGIN IMMEDIATE`) or
  use conditional `UPDATE ... WHERE revision_id = ?` and inspect changed
  rows in `nucleus-local-store/src/sqlite.rs`
- hold one shared connection (or pool) behind the state service instead of
  opening per operation in `nucleus-server/src/state.rs`
- set WAL, `busy_timeout`, foreign keys at open; run schema init once
- add a multi-thread test proving two `Exact(rev)` writers cannot both
  succeed

## Acceptance

- [x] CAS race closed, proven by concurrent test (`BEGIN IMMEDIATE` around
  check+write; also covers cross-process writers)
- [x] repositories from one backend share one `Arc<Mutex<Connection>>`;
  schema and pragmas run once per backend
- [x] WAL + busy_timeout(5s) + synchronous NORMAL + foreign keys active

## Validation

- `cargo test -p nucleus-local-store`
- `cargo test -p nucleus-server`

## Stop Conditions

- stop before changing the record schema or domain table layout
