# Keymap Persistence And Resolution

Date: 2026-08-02
Roadmap: `g05/012-command-catalogue-keymaps-and-palette.md`
Card: `g05/batch-cards/037-keymap-persistence-and-resolution.md`

## Outcome

Nucleus now composes Longhorn's keymap config and narrow Tauri host around the
sealed semantic catalogue. The immutable `nucleus:default` preset contains
physical primary-modifier bindings for Settings, editor quick-open, and editor
save. Meta and Control labels resolve from the same definitions per platform.

The ordinary user-config domain persists only active preset identity,
monotonic revision, and sparse directives. Preview and commit bind exact
registry, revision, preset, and patch-digest evidence. Conflicts, invalid
bindings, reserved chords, stale evidence, unauthorized callers, and recovery
remain typed outcomes. Reset restores the compiled preset without copying it
into user config.

The host exposes catalogue and keymap query/mutation only. Product command
execution remains behind Nucleus's fresh typed admission. Editor editing, text
input, IME, focus, and accessibility behavior are not registered as global
shortcuts.

## Evidence

- seven focused command and keymap fixtures pass
- `effigy check:rust` passes
- docs and Northstar checks pass
- Doctor retains the existing repository structural error set; the new command
  and keymap modules add no Doctor findings
- the Longhorn consumer replay remains blocked by unrelated dirty
  `packages/settings/src/poodle/SettingsShell.svelte` and
  `packages/settings/tests-svelte/shell.test.ts` files in the Longhorn worktree
- no authenticated provider work ran

## Next

Execute card 038. Compose one compact palette, shared shortcut presentation,
and a keybinding Settings page, then run deterministic and native acceptance.
