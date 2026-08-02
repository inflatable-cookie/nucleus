# 038 Command Palette And Acceptance

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../012-command-catalogue-keymaps-and-palette.md`
Depends on: card 037
Auto-start next card: yes

## Objective

Compose one compact command palette and keybinding settings page, then close
the command-system acceptance pass.

## Acceptance

- [x] admitted commands are searchable with current availability and shortcuts
- [x] unavailable results explain why and cannot execute
- [x] palette, menus, and shortcuts project the same catalogue
- [x] focus return, dismissal, text input, IME, and stale-state behavior pass

## Validation

- [x] focused Svelte, mounted desktop, keyboard, and accessibility fixtures pass
- [x] native app launch accepts the exact command package and palette composition;
  deterministic keyboard fixtures cover modifier delivery that the native UI
  automation driver could not synthesize

## Stop Conditions

- do not add visible toolbar actions merely to expose catalogue coverage
