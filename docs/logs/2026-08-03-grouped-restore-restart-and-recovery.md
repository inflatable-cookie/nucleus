# Grouped Restore Restart And Recovery

Date: 2026-08-03
Cards: g05.046-g05.047

## Implemented Result

Nucleus now restores its exact seven configuration domains as one Longhorn
grouped transaction. The live process only inspects, confirms, and persists a
restart request. Boot recovers any interrupted group, revalidates the archive
and complete plan, then publishes before database, window, Settings, command,
notification, bridge, terminal, or server authorities open.

File adapters stage exact target and rollback payloads and publish through
durable atomic replacement. SQLite uses its online backup API for capture,
stage, restore, and verification; main database, WAL, and shared-memory file
copying remain forbidden.

The active Restore page shows the exact plan and restart consequence before
confirmation, plus the last durable committed, rejected, or rolled-back boot
receipt.

## Absence Gate Resolution

Longhorn commit `f2a78690738e0224351f0b097b162e46bf5b8c44` added explicit
present/absent target and rollback evidence. Nucleus migrated grouped file and
SQLite adapters, present-only storage-migration adapters, and durable boot
receipt projection to that vocabulary.

Archived file absence now deletes through the grouped adapter. Archived SQLite
absence deletes the main database, WAL, and shared-memory files. Interruption
recovery can restore an applied domain to exact prior absence. Zero-payload
absence remains distinct from an empty synthetic document.

## Evidence

- focused configuration and restore Rust fixtures: 12 passed, including file
  and SQLite target deletion plus rollback to absence after interruption
- focused Settings authority fixtures: 9 passed
- Restore Settings component fixture: 1 passed
- Rust check, desktop type check, and production build: passed
- exact Longhorn consumer verification: passed at clean selected source
  `03a654baa0296e46eb201339fb12e05aadf9515c`
- Doctor: admitted 26-error oversized/generated baseline only; no new restore
  or backup-domain finding
- separately authorized native restart proof: passed against isolated root
  `/tmp/nucleus-restore-native.Hjvd63`
- inspected archive digest:
  `2f9f2ba343046afd605c11c5ed4665bc6d658818296dfbbc379f3cdd5e23c48c`
- boot receipt: `committed`, seven domains, three archived absences applied as
  deletion, no pending request or journal
- observable rollback target: a preferences file created after backup was
  removed at boot because the archive recorded that domain as absent

Native acceptance also repaired the Tauri custom-protocol feature mapping,
keyed lazy Settings pages by page identity, and removed the macOS picker type
filter that disabled otherwise valid `.longhorn-backup` archives. Exact archive
validation remains the admission boundary after selection.
