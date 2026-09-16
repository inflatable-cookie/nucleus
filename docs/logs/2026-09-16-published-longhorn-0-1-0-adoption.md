# Published Longhorn 0.1.0 Adoption

Date: 2026-09-16
Status: complete
Task: `53737506-15f4-42bb-bce4-7be5ffeb59bc`
Handoff: `../handoffs/20260916-125706-g06-003-adopt-published-longhorn.md`
Planning commit: `028c82cc81f792805a36e201dbce13243a7f27c5`

## Outcome

Nucleus moved off the unpublished Longhorn dependency shape and onto the
published `0.1.0` release. Behaviour is unchanged; only dependency identity
moved.

- `apps/desktop/package.json`: the three
  `@inflatable-cookie/longhorn{,-poodle-svelte,-tauri}` dependencies left
  `file:../../../longhorn/packages/*` behind and now pin `0.1.0` from the npm
  registry. The `overrides` object that existed only to force the adapter's
  exact peer onto the local checkout was removed with them.
- `apps/desktop/package.json`: the Poodle pins moved `0.3.0` → `0.4.2`, the
  release `longhorn-poodle-svelte@0.1.0` peers on. The proof script verifies
  the installed adapter's `peerDependencies` still accept the Nucleus pin.
- `apps/desktop/src-tauri/Cargo.toml`: all 24 `longhorn-*` entries left
  `path = "../../../../longhorn/crates/..."` behind and now resolve
  `{ git = "ssh://git@github.com/inflatable-cookie/longhorn.git", tag = "v0.1.0" }`.
  Longhorn's crates set `publish = false`, so the tag is the published
  identity.

The consumer-boundary proof (`scripts/verify-longhorn-consumer-boundary.ts`)
was rewritten for the published shape. It no longer packs the private sibling
checkout: it installs the three published renderer packages at `0.1.0` plus
the pinned Poodle release into an isolated consumer, proves exactly the three
Longhorn packages with one Svelte and one Poodle runtime, checks the installed
adapter's `peerDependencies` against both Nucleus Poodle pins, and asserts
every `longhorn-*` Rust crate resolves version `0.1.0` from git tag
`v0.1.0` of `ssh://git@github.com/inflatable-cookie/longhorn.git`, proven
against the resolved source cargo tree prints on each crate line. All
forbidden-import, forbidden-crate, adapter, and lifecycle-evidence assertions
are retained. `scripts/README.md` was updated to describe the
published-release proof.

`AGENTS.md` dropped the mandatory sibling Longhorn checkout requirement: with
both the Bun `file:` and Cargo path dependencies gone, the build no longer
reaches Longhorn through the parent directory, and the previous bullet
explicitly forbade the git-tag pin this task had to apply.

## Resolved Versions

- `@inflatable-cookie/longhorn` 0.1.0 (npm)
- `@inflatable-cookie/longhorn-poodle-svelte` 0.1.0 (npm)
- `@inflatable-cookie/longhorn-tauri` 0.1.0 (npm)
- `@inflatable-cookie/poodle-core` 0.4.2 (npm)
- `@inflatable-cookie/poodle-svelte` 0.4.2 (npm)
- all 24 `longhorn-*` crates 0.1.0 from
  `ssh://git@github.com/inflatable-cookie/longhorn.git` tag `v0.1.0`

## Checks

- `effigy qa` green (docs checks, Rust workspace tests, desktop Bun/Vitest
  suites, renderer build, and the consumer-boundary proof).
- `effigy qa:docs` green.

## Stop Conditions

None hit: every API Nucleus uses is present in published `0.1.0`, and the
Poodle `0.3` → `0.4` jump did not break the renderer.
