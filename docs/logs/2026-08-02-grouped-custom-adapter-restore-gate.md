# Grouped Custom-Adapter Restore Gate

Date: 2026-08-02
Card: g05.046

## Result

Restore remains disabled. The blocker is not only live SQLite quiescence.
Nucleus registers all seven backup domains through Longhorn custom adapters,
while Longhorn's public restore seam executes one custom domain at a time.

Longhorn's ordinary file-domain restore has a durable group journal and exact
rollback. `BackupAdapterRestoreParticipation::FailureAtomic` instead describes
one adapter's own publication. It does not group independent adapter calls.
Sequentially restoring Nucleus's seven domains could therefore leave a mixed
generation after failure or interruption.

Nucleus will not duplicate Longhorn's restore transaction. Card 046 resumes
only after Longhorn exposes a grouped custom-adapter transaction and Nucleus
can schedule it durably for boot before `DesktopState` and file-backed owners
open.

## Evidence

- Nucleus backup catalogue: seven custom adapters, all restore-excluded
- Longhorn ordinary restore: one staged group journal and rollback set
- Longhorn custom restore: one domain, one confirmation, one receipt per call
- shared Backup Settings UI: no restore claim without advertised capability

No restore capability or destructive UI was enabled.
