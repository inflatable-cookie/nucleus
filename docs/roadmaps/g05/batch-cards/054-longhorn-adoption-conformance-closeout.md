# 054 Longhorn Adoption Conformance Closeout

Status: paused after implemented-lane conformance; waits for card 047
Owner: Tom
Created: 2026-08-01
Milestone: `../018-longhorn-adoption-closeout-and-deferrals.md`
Depends on: cards 029, 032, 035, 038, 041, 044, 047, and 049
Auto-start next card: yes

## Objective

Audit every implemented Longhorn adoption lane against exact artifacts,
authority ownership, lifecycle, restart, rollback, and structural health.

## Acceptance

- [x] each implemented adopted package resolves to one exact clean Longhorn source
- [x] no duplicate or superseded Nucleus mechanism remains active
- [x] package capability and Nucleus product authority remain distinguishable
- [x] Doctor structural debt is no worse than the admitted baseline

## Validation

- [x] dependency and focused conformance checks pass
- [x] docs and Northstar checks pass
- [x] diff-hygiene checks pass

## Stop Conditions

- cards 050 and 051–053 may remain paused and must not be implied complete

## Pause Evidence

Cards 029, 032, 035, 038, 041, 044, 048, and 049 are complete. Card 047 cannot
close until Longhorn provides grouped custom-adapter restore and Nucleus
provides boot-time quiescence plus a durable restart handoff. Conformance has
passed for every implemented lane, but the adoption closeout must not be
marked complete while recovery acceptance remains absent.

The expanded consumer verifier passes at exact clean Longhorn commit
`3032545b3284d3af7f976a88827bb8c8f5c94513`. It covers commands, config,
operations, notifications, bridge, settings, layout, windowing, and native
content packages and crates. Its bridge lifecycle evidence now points to the
consumer-native Tauri invocation fixture. Splitting backup retention from the
authority returned Doctor to the admitted 26 oversized-file error baseline;
the remaining structural debt stays outside this lane.
