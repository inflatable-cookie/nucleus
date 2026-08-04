# 046 Restore And Recovery

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../015-backup-restore-and-recovery-controls.md`
Depends on: card 045
Auto-start next card: yes

## Objective

Stage, inspect, plan, confirm, publish, and recover restores without creating
dual authority.

## Acceptance

- [x] restore input is validated and inspected before publication
- [x] conflicts and restart consequences are bound to a confirmation plan
- [x] publish has exact rollback and interruption behavior
- [x] recovery state survives restart and remains actionable
- [x] archived absent domains restore as deletion inside the grouped transaction

## Validation

- [x] corrupt, stale, conflicting, interrupted, rollback, and recovery fixtures pass
- [x] absent file and SQLite targets delete inside the grouped transaction
- [x] interrupted publication rolls an applied domain back to exact absence

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

## Resume Evidence

Longhorn commit `aaeb680c` supplies grouped failure-atomic custom-adapter
restore. One archive, exact selected domains, and one confirmation bind the
transaction. Longhorn stages every target and rollback payload before mutation,
journals stable apply order, rolls back in reverse order, and recovers at boot
through the exact adapter catalogue. Mixed file and WAL-mode SQLite fixtures
cover apply, verification, rollback, and interruption.

Nucleus now owns the remaining boundary: exact seven-domain grouped adapters,
a durable restart request, and recovery/execution after storage preparation but
before any product authority opens.

## Implemented Evidence

The live process inspects an exact archive and confirmation, persists one
restart request, then requests application restart. Boot reconstructs the exact
seven-domain catalogue, invokes Longhorn recovery first, revalidates all
evidence, and executes before any product authority opens. File domains use
durable atomic replacement. SQLite stages and restores through its native
backup API, including WAL-mode fixtures.

Focused fixtures cover archive and current-state drift, corrupt pending state,
all-domain commit, process interruption during apply, reverse rollback, clean
restart, durable terminal receipts, and safe absent-domain rejection. The
restore suite passes 12 tests.

## Historical Reopened Gate

Nucleus backups preserve missing optional documents as absent manifest domains.
Longhorn's grouped custom-adapter plan initially required a present target
digest and target verification compares only `Some(target_evidence)`. Its
verify request has no expected-state discriminator. An adapter therefore
cannot safely distinguish target deletion from rollback to an absent prior
state across restart.

Nucleus could not encode absence as a synthetic payload, omit the domain, or run
deletion outside the group without violating backup truth or failure atomicity.
The Restore Settings capability and native commands remained unregistered. Card
046 could resume only when Longhorn modelled absent target evidence through planning,
journalling, apply, verification, rollback, and boot recovery.

## Second Resume Evidence

Longhorn commit `f2a78690738e0224351f0b097b162e46bf5b8c44` now carries
explicit present/absent target and rollback evidence through inspection,
confirmation, journal v2, apply, verification, rollback, recovery,
projections, and receipts. Zero-payload deletion, rollback to absent, mixed
file/WAL SQLite, interruption, and boot recovery fixtures pass upstream.

That handoff reopened the Nucleus adapter, durable receipt, and deterministic
lifecycle work recorded below.

## Completion Evidence

Nucleus now uses `BackupAdapterStateEvidence` through grouped inspection,
staging, apply, verification, durable boot receipts, and the older present-only
migration adapters. Absent file targets delete atomically. Absent SQLite
targets remove the main database, WAL, and shared-memory files. Durable receipt
v2 preserves target and rollback evidence for every domain.

The 12-test configuration matrix passes. It covers all-domain commit, file and
SQLite target deletion, rollback to an absent file after simulated process
interruption, archive and current-evidence drift, corrupt pending state, and
clean restart. Restore commands and the Settings capability are registered.
Longhorn consumer verification passes at exact clean commit
`f2a78690738e0224351f0b097b162e46bf5b8c44`.
