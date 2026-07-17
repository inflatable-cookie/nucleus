# 206 Monotonic Event Sequencing

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../044-persistence-correctness-hardening.md`
Auto-start next card: no

## Objective

Replace lexicographic event-id ordering with a monotonic sequence for the
event journal, replay, and cursors.

## Steps

- add a `seq` column (AUTOINCREMENT or rowid) to the event journal
- order replay by `seq`; make `EventStoreCursor` numeric
- migrate existing journals (backfill seq by current ordering, recorded as a
  one-time migration)
- add replay test with command ids whose lexicographic order differs from
  append order

## Acceptance

- [ ] replay order equals append order, proven by test
- [ ] cursors are numeric and resumable
- [ ] existing stores migrate without data loss

## Validation

- `cargo test -p nucleus-server event_store`
- `cargo test -p nucleus-orchestration`

## Stop Conditions

- stop before redesigning event payload schemas or retention
