# Papercuts

Small, actionable friction found during agent work. Agents append entries when
they hit a solvable hurdle; they do not stop the current task to fix one.

## Open

## Closed

### [x] `effigy deps link bun` blocked by nested duplicate svelte copy — 2026-08-10
- Friction: Linking poodle local source into `apps/desktop`
  (`effigy deps link bun ../../../poodle`) failed because poodle's
  `node_modules/.bun` held a second svelte copy (`svelte@5.56.8`) alongside
  the hoisted one; the linker refused until the nested copy was deleted.
- Impact: One manual `rm -rf` of a regenerable directory before the link
  succeeds; poodle's next `bun install` may recreate the conflict.
- Fix: Effigy now treats same-version peer installs across consumer and
  library trees (including `.bun` copies) as shared; only mismatched peer
  versions fail. Exit-non-zero for failed deps mutations was already landed.
- Surface: `effigy deps link bun`, TS side; first proven use of the flow
  (nucleus desktop ← poodle local source, 2026-08-10).
- Addendum (2026-08-11): the linker prints `Errors (1)` for the
  duplicate-svelte case but exits 0, so shell fallbacks
  (`cmd || recovery`) do not fire — check output, not exit code, or fix
  the exit contract in effigy. *(Exit contract fixed earlier in Effigy;
  same-version peer sharing fixed with this close.)*
