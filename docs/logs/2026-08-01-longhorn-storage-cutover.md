# Longhorn Storage Cutover

Date: 2026-08-01
Status: implemented

## Changed

- changed the Tauri and storage identity to `com.inflatablecookie.nucleus`
- replaced the desktop `~/.nucleus` default with Longhorn
  `platform-native-v1`
- replaced the proof root override with explicit `portable-v1`
- moved durable SQLite to `data/databases/nucleus.sqlite`
- split native placement and project layouts into state and config documents
- imported legacy SQLite through the online backup API
- imported review snapshots and editor drafts through bounded tree adapters
- committed the fixed profile locator last and retained the legacy root
- exposed profile, layout digest, and typed import receipt in startup status

The CLI current-directory database policy did not change.

## Evidence

- three-platform canonical-leaf path matrix
- missing legacy root
- corrupt and future combined UI documents
- occupied split target
- live WAL snapshot with source WAL invariance
- split UI and two tree copies
- locator-last commit and retained-source receipt
- independent window and project-layout mutation

## Rollback

The old `.nucleus` tree is not deleted or mutated. The previous desktop build
can reopen it. The new runtime never reads or dual-writes it after the locator
selects the platform-native target.
