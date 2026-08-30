# Papercuts

Small, actionable friction found during agent work. Agents append entries when
they hit a solvable hurdle; they do not stop the current task to fix one.

## Open

### [x] `check:longhorn-consumer` red on main before Poodle bump — 2026-08-24
- Friction: Verifier still expected packed Poodle preview artifacts, Rust `longhorn-layout*` allowlist, and forbade `longhorn-surfaces*`; also `workspaceLayout.ts` imported `SurfaceDocument` from `@inflatable-cookie/longhorn/surfaces`. Fails on clean `91316dbe` against Longhorn after Card 179 / g16.008.
- Impact: Required g16.011 validation could not pass.
- Fix: Point verifier at published Poodle 0.2.2, admit surfaces crates, import `SurfaceDocument` from `longhorn/layout`. Consider a CI signal so the consumer check cannot stay red unnoticed.
- Surface: `scripts/verify-longhorn-consumer-boundary.ts`, workspace layout module.

## Closed

### [x] Worker handoff path not in Nucleus checkout — 2026-08-24
- Friction: Operator prompt cited `docs/handoffs/20260824-231356-g16-011-nucleus-v022-adoption.md` relative to the Nucleus worktree, but the file lives only under Poodle (`/Users/tom/Dev/projects/poodle/docs/handoffs/...`). Nucleus had no `docs/handoffs/` then; it now holds Nucleus-owned handoffs only.
- Impact: Worker startup required a filesystem search before reading the execution contract.
- Fix: Northstar PR 8 (`1840c9f6d4f7127240622a09e462b06adc094971`) requires the owning repo's absolute handoff path for operator-facing dispatch. `AGENTS.md` and `034-agent-instruction-surface-contract.md` state that rule; do not copy Poodle handoffs into Nucleus.
- Surface: Poodle orchestrator worker handoffs for cross-repo adoption lanes; Nucleus `docs/handoffs/` for Nucleus-owned lanes.
- Closed: 2026-08-30 (papercuts wave 18).

### [x] Nucleus worktree missing sibling Longhorn symlink — 2026-08-24
- Friction: Launcher worktree at `.t3/worktrees/nucleus/<id>` has no `../longhorn` symlink; `apps/desktop` `file:../../../longhorn/...` deps and `check:longhorn-consumer` both need `/Users/tom/.t3/worktrees/nucleus/longhorn` → main Longhorn checkout. Soundcheck/bovine-accelerator-desktop worktree containers already ship that sibling link.
- Impact: First `bun install` failed with ENOENT for the three Longhorn packages until the symlink was created by hand.
- Fix: `AGENTS.md` now states the sibling rule — create when absent, reuse only a correct symlink, stop on conflict, never overwrite. Workers create `.t3/worktrees/nucleus/longhorn` → the primary Longhorn checkout; do not retarget path deps to git pins; do not automate T3.
- Surface: T3/nucleus worktree bootstrap; local `file:` Longhorn deps.
- Closed: 2026-08-30 (papercuts wave 17).

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
