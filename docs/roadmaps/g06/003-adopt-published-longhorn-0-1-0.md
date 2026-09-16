# g06.003 Adopt Published Longhorn 0.1.0

Owner: repo maintainers
Created: 2026-09-16
Governing refs: Longhorn contract 012; Longhorn `g02.014` consumer repoint
Depends on: no other Queue task
UI classification: none

## Outcome

Nucleus moves off its unpublished-Longhorn dependency shape and onto the
published release: `@inflatable-cookie/longhorn{,-poodle-svelte,-tauri}` from
npm at `0.1.0`, and the `longhorn-*` crates by git tag `v0.1.0`. Behaviour is
unchanged; only the dependency identity moves.

## Context

Longhorn published `0.1.0` on 2026-09-16 and is tagged `v0.1.0`. Its Rust
crates set `publish = false`, so consumers take them by git tag. Nucleus takes
Longhorn by `file:` in `apps/desktop/package.json` (with an `overrides` entry
that exists only to satisfy the adapter's exact peer) and by `path` in
`apps/desktop/src-tauri/Cargo.toml`. That was correct while Longhorn was
unpublished and is now stale.

## Ready-State Rubric

- [x] Longhorn `0.1.0` is published and tagged.
- [x] This is dependency maintenance and changes no product priority.
- [x] No other Nucleus lane owns these manifests.
- [x] UI classification is none.

## Work

1. `apps/desktop/package.json`: the three `file:../../../longhorn/packages/*`
   deps become `"0.1.0"`; the `@inflatable-cookie/longhorn` `overrides` entry
   goes with them.
2. `apps/desktop/src-tauri/Cargo.toml`: every `longhorn-*` entry with
   `path = "../../../../longhorn/crates/..."` becomes
   `{ git = "ssh://git@github.com/inflatable-cookie/longhorn.git", tag = "v0.1.0" }`.
3. `apps/desktop/package.json` Poodle pins move `0.3.0` → `0.4.2`, because
   `longhorn-poodle-svelte@0.1.0` peers on Poodle `0.4.2`.
4. Run Nucleus's own checks (`effigy qa`).

## Acceptance and review oracle

| Invariant | Required proof |
| --- | --- |
| No unpublished Longhorn reference survives | no `file:`/`path` reference to Longhorn outside historical records |
| TypeScript resolves the release | the three packages resolve `0.1.0` from the registry |
| Rust resolves the tag | `longhorn-*` resolves git tag `v0.1.0` |
| The app still builds | `effigy qa` green |

## Stop conditions

Stop if an API Nucleus uses is absent from published `0.1.0`, or if the Poodle
`0.3`→`0.4` jump breaks the renderer. Record the gap; do not reintroduce a path
dependency.

## Evidence

On completion, record: the changed manifests, the resolved versions, and the
`effigy qa` result.
