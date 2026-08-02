# 029 Secondary-System Conformance Baseline

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../009-longhorn-secondary-system-admission.md`
Depends on: card 028
Auto-start next card: yes

## Objective

Add reusable focused conformance checks for every admitted Longhorn integration
edge and leave Settings ready to start.

## Acceptance

- [x] fixtures cover source identity, lifecycle, teardown, restart, and failure truth
- [x] package capabilities are distinguished from Nucleus product admission
- [x] duplicate framework runtimes and duplicate state authorities fail deterministically
- [x] the Settings integration edge is named and documented

## Validation

- [x] focused Rust, desktop, Svelte, and docs selectors pass
- [x] exact produced-package evidence is recorded

## Stop Conditions

- stop if a fixture requires raw Longhorn internals rather than its public contract

## Evidence

- `effigy check:longhorn-consumer` is a Nucleus-owned public-contract and
  produced-artifact check included in `effigy qa`
- it rejects dirty selected sources, source aliases in the proof install,
  duplicate Svelte/Poodle runtimes, forbidden Surface/history packages,
  missing Rust crates, and broadened product authority
- restart, interruption, receipt recovery, and Surface-free layout evidence is
  linked to focused Nucleus fixtures rather than copied Longhorn internals
- Settings starts at `settings registry adapter and consumer-owned page modules`
