# Backup Inventory And Restore Gate

Date: 2026-08-02
Cards: g05.045-g05.047

## Result

Nucleus now composes Longhorn storage diagnostics, bounded operational backup
inventory, capture, and retention through Settings. The catalogue contains
exactly seven Nucleus-owned domains: SQLite, preferences, command keymap,
project layouts, panel presentations, window placement, and notifications.

SQLite is captured with its online backup API and checked before archive
publication. Optional files remain absent when they do not exist. Inventory is
bounded to 1,024 scanned entries. Retention keeps ten archives and binds exact
paths and digests into a revalidated confirmation plan.

## Boundary

Credentials, Browser data, raw provider and terminal streams, project
resources, editor drafts, and expired review evidence are outside the
catalogue. Focused exclusion fixtures verify sentinel bytes from excluded
locations do not enter an archive.

Export remains unavailable because the current Longhorn configuration command
cannot safely rendezvous with an asynchronous host save destination. Restore
reached its stop condition: Nucleus has no process-wide quiescence and restart
journal for replacing its already-open SQLite authority with the other file
domains atomically. The host advertises neither capability. Settings therefore
does not imply unavailable recovery controls.

## Evidence

- backup capture, exclusion, SQLite validity, corrupt inventory, and retention
  Rust fixtures: 3 passed
- Settings registry, persistence, and authority fixtures: 9 passed
- desktop Svelte check: zero errors; one pre-existing ProjectRail warning
- isolated exact-package native launch and protected-window initialization:
  passed; the macOS UI driver could not attach to the dev binary, so no visual
  Settings or recovery claim is recorded

## Resume

Compose host-selected export publication. Then contract and implement
app-wide quiescence, offline SQLite replacement, restart-journal recovery, and
exact rollback before enabling restore.
