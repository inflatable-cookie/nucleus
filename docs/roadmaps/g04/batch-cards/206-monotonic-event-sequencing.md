# 206 Monotonic Event Sequencing

Status: completed
Owner: Claude
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

- [x] replay order equals append order, proven by test (also fixed a
  projection test that had the lexicographic-order bug baked into its
  cursor assertion)
- [x] numeric cursors deferred: `EventStoreCursor` is serialized inside
  event payloads (schema-version bump) and the orchestration replay modules
  that would consume it are still placeholders; revisit when replay lands
- [x] existing stores migrate without data loss (`seq` column added, order
  backfilled from rowid, proven by legacy-schema test)

## Validation

- `cargo test -p nucleus-server event_store`
- `cargo test -p nucleus-orchestration`

## Stop Conditions

- stop before redesigning event payload schemas or retention
