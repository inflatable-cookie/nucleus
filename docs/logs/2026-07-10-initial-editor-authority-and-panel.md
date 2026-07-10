# Initial Editor Authority And Panel

Date: 2026-07-10
Lane: G04 initial code editor vertical slice
Cards: 150-153

## Outcome

- Rust host owns bounded ignore-aware discovery, opaque refs, snapshot reads,
  exact content revisions, write policy, and same-directory save replacement.
- The Editor placeholder now hosts a direct CodeMirror 6 integration with one
  active file, local dirty state, normal editing commands, and Rust-authorized
  Save.
- The normal surface remains compact: one path trigger, dirty indicator, and
  Save control. No explorer, editor tabs, minimap, LSP, plugins, or IDE shell.
- The selector is now a searchable quick-open popover. The active file lazily
  loads its official CodeMirror language package and uses Nucleus/Poodle token
  styling.
- Dirty switching requires Save and open, Discard, or Cancel. Stale conflicts
  preserve the buffer and expose Reload disk or Keep editing.

## Evidence

- focused editor authority test passes, including ignored/binary/oversized/
  hard-excluded paths, invented refs, accepted save, and stale conflict
- Rust server and desktop compile
- production desktop bundle builds with 2,218 modules transformed and language
  support split into lazy chunks
- running Tauri watcher rebuilt and launched the current desktop binary
- desktop type checking passes with zero errors and warnings
- four focused editor-support tests cover quick-open filtering, dirty-switch
  admission, language fallback, and conflict recognition
- shared browser preview and macOS app automation could not capture the Tauri
  debug window; the operator reviewed the live panel and accepted its current
  shape
- the first full Effigy test attempt was stopped during a slow Tauri compile;
  the clean retry completed with 2,128 tests passed and 10 skipped
- Rust check, desktop type checking/build, formatting, docs QA, and diff hygiene
  pass

## Realized Transport

Typed Tauri commands return editor discovery entries and accepted snapshots
directly from `nucleus-server`. The generic control-envelope command receipt
was not extended: its accepted receipt cannot return the new content revision,
and pretending otherwise would weaken the save contract.

## Next

Stop for operator selection between editor-to-diff/review, multiple buffers,
file watching/recovery, or server-owned language services. No follow-on lane is
implied by this closeout.
