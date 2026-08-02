# 031 Settings Dialog And Session

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../010-longhorn-settings-shell.md`
Depends on: card 030
Auto-start next card: yes

## Objective

Compose one sparse top-level Settings dialog with isolated session state,
search, deep links, and lazy consumer-owned page bodies.

## Acceptance

- [x] one shell trigger opens the accessible Settings dialog
- [x] page bodies load only when selected and use public Poodle composition
- [x] dirty staged state is guarded on page switch and close
- [x] conflict, recovery, activation, and unsupported states are visible

## Validation

- [x] focused Svelte and mounted desktop fixtures pass
- [x] narrow layout, keyboard, focus, and remount behavior pass

## Stop Conditions

- do not add permanent shell chrome for advanced settings

## Evidence

- one toolbar gear mounts Longhorn's modal `SettingsShell`; closing unmounts
  the isolated session
- General and Appearance bodies are consumer-owned lazy chunks composed from
  public Poodle controls
- mounted fixtures cover immediate and staged writes, dirty close guard,
  conflict preservation, page swapping, remount, and listener teardown
- native acceptance confirms the Browser child view is suppressed only while
  the modal is open and restored after close
