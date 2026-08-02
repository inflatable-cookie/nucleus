# 045 Backup Inventory And Capture

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../015-backup-restore-and-recovery-controls.md`
Depends on: card 044
Auto-start next card: yes

## Objective

Inventory explicit Nucleus backup domains and compose consistent bounded
capture, export, and retention.

## Acceptance

- [x] included domains, schema versions, revisions, and exclusions are inspectable
- [x] SQLite-backed domains are captured consistently
- [x] credentials, Browser data, raw streams, and expired evidence are excluded
- [x] capture and export produce truthful receipts and bounded retention

## Validation

- [x] inventory, consistency, exclusion, and retention fixtures pass

## Evidence

- seven exact domains are registered through focused adapters
- SQLite uses an online backup and `PRAGMA quick_check` before publication
- operational inventory scans at most 1,024 entries and retention keeps ten
- focused Rust fixtures pass for capture, exclusions, corrupt inventory, and
  confirmation-bound retention
- Settings exposes storage diagnostics, inventory, capture, and retention
- Settings advertises export only after the Nucleus native picker and exact
  Longhorn user-export path are composed
- a selected source is re-listed and digest-checked after picker interaction;
  changed sources and raced destinations fail typed without publication
- Longhorn commit `3032545b3284d3af7f976a88827bb8c8f5c94513`
  supplies canonical verified operational-to-user-export re-encoding
- focused fixtures prove exact payload preservation and single-use target
  correlation
- the native development app launched, but macOS automation could not attach
  to its hidden-restored window (`cgWindowNotFound`); visual picker observation
  remains part of card 047 acceptance

## Stop Conditions

- do not infer backup scope from filesystem reachability
