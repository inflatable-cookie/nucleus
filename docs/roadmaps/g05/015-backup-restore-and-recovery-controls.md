# 015 Backup, Restore, And Recovery Controls

Status: completed
Owner: Tom
Created: 2026-08-01

## Purpose

Turn the adopted Longhorn storage foundation into explicit Nucleus backup,
restore, and recovery controls inside Settings.

## Governing Refs

- `../../contracts/008-storage-state-persistence-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../../../longhorn/docs/contracts/004-configuration-storage-backup-and-recovery.md`
- `../../../../longhorn/docs/contracts/005-settings-and-system-registration.md`

## Generation Runway Goal

Make local client recovery usable without widening storage authority.

## Goals

- [x] inventory explicit Nucleus backup domains and exclusions
- [x] compose bounded backup capture, export, and retention
- [x] compose restore inspection, conflict planning, confirmation, and recovery
- [x] expose truthful available capabilities and receipts through Settings

## Execution Plan

### Batch 15.1 — Backup Adapters And Inventory

- [x] Execute card 045.
- [x] preserve SQLite consistency and bounded retention
- [x] exclude credentials, Browser data, raw streams, and expired evidence

### Batch 15.2 — Restore And Recovery

- [x] Execute card 046 after its resume condition is met.
- [x] stage and inspect before publication
- [x] preserve exact rollback and interrupted-recovery behavior

### Batch 15.3 — Settings And Native Acceptance

- [x] Execute the recovery portion of card 047 after card 046.
- [x] compose available shared pages inside the existing Settings shell
- [x] run isolated and separately gated native recovery evidence

## Acceptance Criteria

- [x] backup scope is explicit and inspectable
- [x] restore requires a confirmation-bound plan
- [x] failed or interrupted restore never creates dual authority
- [x] sensitive and expired material remains excluded
- [x] recovery state survives restart and remains actionable

## Batch Cards

- `batch-cards/045-backup-inventory-and-capture.md`
- `batch-cards/046-restore-and-recovery.md`
- `batch-cards/047-backup-recovery-settings-acceptance.md`

## Current Boundary

Backup capture, inventory, host-selected export, retention, and exact
seven-domain grouped restore are active. Restore runs only after confirmation
and restart, before product authorities open. Explicit absent targets delete
inside the Longhorn transaction and interrupted work rolls back to exact prior
presence. Isolated native acceptance committed the grouped plan, restored one
post-backup file to archived absence, projected the durable receipt, and left
no pending request or journal.
