# 047 Backup Recovery Settings Acceptance

Status: paused after partial implementation
Owner: Tom
Created: 2026-08-01
Milestone: `../015-backup-restore-and-recovery-controls.md`
Depends on: card 046
Auto-start next card: yes

## Objective

Compose backup and recovery inside Settings and close isolated plus separately
gated native recovery evidence.

## Acceptance

- [ ] backup inventory, capture, restore plan, confirmation, and recovery are usable
- [x] unavailable destructive operations are absent by capability
- [x] failed work never presents as complete
- [x] sensitive and expired material remains absent from artifacts and UI

## Validation

- [x] focused Settings, persistence, and backup fixtures pass
- [ ] separately authorized native recovery proof passes

## Stop Conditions

- do not run destructive native restore without an isolated state root and operator gate

## Evidence

The shared Storage and Backup pages are composed in the existing Settings
shell. Restore controls are absent because the host does not advertise restore
capabilities. Card 046 must resume after Longhorn provides grouped
custom-adapter restore and Nucleus provides boot-time quiescence before
recovery UI or native destructive evidence can be admitted.
