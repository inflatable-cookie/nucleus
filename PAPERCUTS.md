# Papercuts

Small, actionable friction found during agent work. Agents append entries when
they hit a solvable hurdle; they do not stop the current task to fix one.

## Open

### [ ] Main checkout `.cargo/config.toml` missing at card dispatch — 2026-08-10
- Friction: Card 091 Environment Notes instruct workers to copy
  `.cargo/config.toml` verbatim from the main checkout
  (`/Users/tom/Dev/projects/nucleus/.cargo/config.toml`) before building.
  The directory exists but is empty; the file is gitignored and absent from
  git history, so it cannot be recovered.
- Impact: Workers must reconstruct the swallowtail sibling patch from the
  card's prose instead of copying it; the reconstructed patch also rewrites
  the five swallowtail entries in `Cargo.lock` to path sources on every
  cargo invocation, requiring a lockfile restore before committing.
- Possible fix: Commit a documented template (or the real file with
  relative paths) so the machine-local patch is reproducible, or note in
  the card that the file is machine-local and may be absent.
- Surface: `nucleus` worktrees; card 091; swallowtail sibling patching.

### [ ] `effigy deps link bun` blocked by nested duplicate svelte copy — 2026-08-10
- Friction: Linking poodle local source into `apps/desktop`
  (`effigy deps link bun ../../../poodle`) failed because poodle's
  `node_modules/.bun` held a second svelte copy (`svelte@5.56.8`) alongside
  the hoisted one; the linker refused until the nested copy was deleted.
- Impact: One manual `rm -rf` of a regenerable directory before the link
  succeeds; poodle's next `bun install` may recreate the conflict.
- Possible fix: Have the linker dedupe (or ignore) nested `.bun` copies that
  match the hoisted version, or document the deletion step in the link
  command's error output (it already points at the directory).
- Surface: `effigy deps link bun`, TS side; first proven use of the flow
  (nucleus desktop ← poodle local source, 2026-08-10).
