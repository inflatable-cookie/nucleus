# 007 Isolated Native Proof Profile

Status: planned
Owner: Tom
Updated: 2026-07-25
Milestone: `../003-swallowtail-application-proof-readiness.md`
Auto-start next card: yes

## Objective

Resolve one explicit Nucleus desktop data root and one bounded Agent Chat
deadline before any database, config, snapshot, or provider effect.

## Governing Refs

- Contract 008
- Contract 030
- roadmap g05.003

## Scope

1. Add one startup configuration value for `NUCLEUS_DESKTOP_DATA_ROOT`.
2. Keep database, task-review snapshots, and workspace UI config under the
   resolved root.
3. Preserve `~/.nucleus` when the override is absent.
4. Reject an empty, relative, non-directory, or unusable explicit root without
   falling back.
5. Add `NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS`, bounded above by 180 seconds.
6. Pass the selected deadline into the existing Swallowtail chat runtime.
7. Add focused default, override, invalid-value, and path-isolation tests.

## Acceptance

- [ ] one explicit root isolates all three desktop-owned persistence surfaces
- [ ] normal user paths remain byte-for-byte unchanged
- [ ] neither `HOME` nor provider configuration is rewritten
- [ ] invalid configured values fail before state creation or provider work
- [ ] the production deadline remains 180 seconds by default

## Validation

- focused desktop Rust tests
- `effigy desktop:check`
- `git diff --check`

## Evidence

- exact resolved relative path assertions
- failure-before-effects fixtures
- no provider call

## Stop Conditions

- isolation requires repointing `HOME`, `CODEX_HOME`, or another provider path
- UI config remains outside the selected root
- the deadline becomes a renderer-selected per-turn value
- current sidebar changes cannot be preserved cleanly
