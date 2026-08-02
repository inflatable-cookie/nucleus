# 037 Keymap Persistence And Resolution

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../012-command-catalogue-keymaps-and-palette.md`
Depends on: card 036
Auto-start next card: yes

## Objective

Adopt physical-key resolution and sparse user overrides for global semantic
commands.

## Acceptance

- [x] defaults and sparse overrides resolve consistently per supported platform
- [x] conflicts, disabled bindings, invalid inputs, and reset are explicit
- [x] text-input, IME, editor, and accessibility keys retain local ownership
- [x] keymap persistence survives restart without copying the full default map

## Validation

- [x] resolver, conflict, platform, persistence, and input-context fixtures pass

## Stop Conditions

- do not capture local component keys as global shortcuts

## Evidence

- the immutable `nucleus:default` preset binds Settings, editor quick-open,
  and editor save through `KeyboardEvent.code` and semantic primary modifiers
- Longhorn's registered user-config domain persists only active preset,
  revision, and sparse override directives at `commands/keymap.json`
- the primary-window host exposes catalogue, load, preview, digest-bound
  commit, and reset; it exposes no generic command executor
- injected policy rejects current macOS, Windows, and Linux system/application
  chords before publication
- focused fixtures prove macOS/Windows labels, caller scope, conflict and
  reserved rejection, durable restart, reset, text-input admission, and IME
  ownership
