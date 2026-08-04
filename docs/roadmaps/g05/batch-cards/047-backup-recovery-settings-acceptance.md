# 047 Backup Recovery Settings Acceptance

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../015-backup-restore-and-recovery-controls.md`
Depends on: card 046
Auto-start next card: yes

## Objective

Compose backup and recovery inside Settings and close isolated plus separately
gated native recovery evidence.

## Acceptance

- [x] backup inventory, capture, restore plan, confirmation, and recovery are usable
- [x] unavailable destructive operations are absent by capability
- [x] failed work never presents as complete
- [x] sensitive and expired material remains absent from artifacts and UI

## Validation

- [x] focused Settings, persistence, and backup fixtures pass
- [x] separately authorized native recovery proof passes

## Stop Conditions

- do not run destructive native restore without an isolated state root and operator gate

## Evidence

Storage, Backup, and Restore are composed in the existing Settings shell. The
Restore page inspects one archive, presents the exact seven-domain confirmation,
persists a restart request, and reports the durable boot outcome. Explicit
present and absent target/rollback evidence remains intact through receipts.

Focused Settings, restore component, grouped file/SQLite deletion, interruption,
rollback, restart, Rust, desktop, and exact-source consumer checks pass.

The separately authorized native proof ran against isolated root
`/tmp/nucleus-restore-native.Hjvd63`. It captured one backup, wrote a
post-backup preferences document, inspected the exact seven-domain plan, and
restarted into boot restore. Receipt digest
`2f9f2ba343046afd605c11c5ed4665bc6d658818296dfbbc379f3cdd5e23c48c`
reported `committed`. The archived preferences absence deleted the later file,
the Settings UI reported seven restored domains and three applied absences,
and no pending request or journal remained.

Native acceptance also exposed and closed three consumer defects: Tauri dev
had lost its standard custom-protocol feature mapping and loaded stale bundled
assets, the lazy Settings renderer needed page-identity remounting, and the
macOS archive picker needed to leave type selection open before exact archive
inspection.
