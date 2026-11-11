# Papercuts

Small, actionable friction found during agent work. Agents append entries when
they hit a solvable hurdle; they do not stop the current task to fix one.

## Open

<!-- Keep entries short. Append newest entries at the top. Do not include secrets. -->

## Effigy doctor can resolve a parent workspace dependency before bootstrap

- Friction: with no local `node_modules`, `effigy doctor` ran the health task and
  Bun resolved TypeScript from the parent workspace instead of the pinned
  project-l dependency.
- Impact: the boundary proof failed with a misleading API error before
  `effigy bootstrap:deps` restored the local dependency tree.
- Plausible fix: detect missing local bootstrap state before running repository
  health tasks.
- Surface: Effigy doctor and task execution in standalone child directories.

### JS Underlay pin PR left Cargo crates on the previous tag
- **Friction:** PR #16 moved JavaScript Underlay declarations to `v0.9.8`, but
  `apps/acme-api/Cargo.toml` stayed on `v0.9.7`.
- **Impact:** the workspace still had two Underlay identities.
- **Plausible fix:** treat Cargo git tags as part of the same Underlay pin.
- **Surface:** `apps/acme-api/Cargo.toml`

### Installed Northstar language route references missing lifecycle script — 2026-09-13
- Friction: the route fails because `scripts/language-package-lifecycle.ts` is
  absent from the installed skill.
- Impact: the Rust authoring profile cannot be routed.
- Fix: restore the installed package lifecycle host script.

### 2026-09-16 — Fresh Queue worktrees lack the gitignored model weights

- Friction: the model weights are gitignored, so a fresh worktree starts
  without any of them.
- Impact: `effigy qa` is red in every new worktree.

### 20260829-0051 — zsh `path` loop variable shadows `PATH`

- Friction: a shell loop using `path` as its variable made standard commands
  unavailable because zsh maps `path` to `PATH`.
- Impact: one grouped documentation read failed.
