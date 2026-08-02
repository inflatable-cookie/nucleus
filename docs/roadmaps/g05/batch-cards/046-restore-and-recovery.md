# 046 Restore And Recovery

Status: paused at stop condition
Owner: Tom
Created: 2026-08-01
Milestone: `../015-backup-restore-and-recovery-controls.md`
Depends on: card 045
Auto-start next card: yes

## Objective

Stage, inspect, plan, confirm, publish, and recover restores without creating
dual authority.

## Acceptance

- [ ] restore input is validated and inspected before publication
- [ ] conflicts and restart consequences are bound to a confirmation plan
- [ ] publish has exact rollback and interruption behavior
- [ ] recovery state survives restart and remains actionable

## Validation

- [ ] corrupt, stale, conflicting, interrupted, rollback, and recovery fixtures pass

## Stop Conditions

- stop if restore can partially publish without a recoverable authoritative state

## Pause Evidence

`DesktopState` owns an open live SQLite authority before Settings operations are
installed. All seven Nucleus backup domains are custom-adapter domains.
Longhorn can inspect each adapter and execute one confirmed adapter restore,
but its public API does not group several custom adapters into the ordinary
failure-atomic restore transaction. A `FailureAtomic` adapter claim covers that
adapter's own publication only. Calling seven adapters in sequence could leave
preferences, layouts, notifications, and SQLite at different archive
generations after failure.

Nucleus also has no app-wide quiescence boundary, durable restart handoff, or
offline SQLite publication point before `DesktopState` opens. Enabling restore
now would therefore create the exact partial-publication and dual-authority
state forbidden by this card. Nucleus-owned reimplementation of Longhorn's
journal and rollback protocol is not an admissible workaround.

## Resume Condition

Longhorn exposes a grouped custom-adapter restore transaction that binds one
archive and confirmation to the complete selected domain set, journals before
publication, provides exact group rollback and restart recovery, and supports
boot-time execution. Nucleus then contracts and implements process-wide
quiescence plus a durable restart handoff so the grouped transaction runs
before live authorities open. Only then may Nucleus advertise restore.
