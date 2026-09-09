# 014 Notification Ledger And Attention

Status: completed
Owner: Tom
Created: 2026-08-01

## Purpose

Add retained, finite background attention through Longhorn notifications while
keeping the normal shell quiet.

## Governing Refs

- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../../../longhorn/docs/contracts/016-notification-ledger-and-projection.md`

## Generation Runway Goal

Surface important background outcomes without permanent diagnostic chrome.

## Goals

- [x] define which Nucleus facts create notifications
- [x] add finite unseen, seen, replacement, dismissal, and retention authority
- [x] compose transient toasts and one toolbar popover
- [x] route semantic actions through fresh command admission

## Execution Plan

### Ledger And Product Projection

- [x] map selected failures, interruptions, and attention-worthy completions
- [x] keep wording, severity, and redaction in Nucleus

### Toasts, Popover, And Actions

- [x] compose public Poodle feedback primitives
- [x] keep toast expiry separate from seen and dismissed state

### Notification Acceptance

- [x] prove replacement, retention, remount, multi-window observation, and
  action authorization
- [x] validate that routine success stays quiet

## Acceptance Criteria

- [x] unseen count is authoritative and not inferred from retained count
- [x] notification records carry no secrets or raw provider material
- [x] actions rerun Nucleus authorization
- [x] toast expiry never removes the retained record
- [x] normal shell attention remains visually minimal

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.

- `042-notification-ledger-and-projector.md` — completed (collapsed into this task)
- `043-notification-presentation-and-actions.md` — completed (collapsed into this task)
- `044-notification-acceptance.md` — completed (collapsed into this task)
- `096-message-centre-adoption.md` — completed (MessageCentre and toast delivery; collapsed into this task)
- `097-failure-notification-routing.md` — completed (operator-facing failure routing into this ledger; collapsed into this task)
