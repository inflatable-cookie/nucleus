# Longhorn Consumer Admission Closeout

Date: 2026-08-01
Status: complete
Roadmap: g05.009
Cards: 027-029

## Outcome

Nucleus has a bounded Longhorn consumer edge before Settings work begins.
Selected Longhorn package/crate inputs were clean at commit
`976a40875408cfd9547aad519ce4463ed3ac8494`; unrelated Loophole roadmap and
script changes remained outside the selected tree. Its selected-tree SHA-256
was `4aa8a8025a1357df697e899f55b77c2796429d303632480e8fcb86c7d3393c96`.

`effigy check:longhorn-consumer` now:

- checks the admitted renderer and Rust dependency allowlists
- packs six private Longhorn renderer packages
- verifies the exact Poodle artifact set and artifact digests
- installs the graph outside Nucleus, Longhorn, and Poodle
- proves one Svelte runtime and one Poodle runtime
- rejects Surface/history packages and crates
- links restart, failure, recovery, and Surface-free evidence to Nucleus tests
- names Nucleus product ownership and the next Settings adapter edge

The selector is part of `effigy qa`. It does not require either sibling
worktree to be globally clean; only the exact selected source paths must be
clean. That matches Longhorn's existing private-artifact admission semantics
without consuming uncommitted sibling work.

## Structural Split

The retained application adapters were decomposed without schema or behavior
changes:

- `storage_migration` now separates coordinator, SQLite, tree, split-UI, and
  test modules
- `desktop_profile` now separates profile state, host facts, validation, and
  tests
- `workspace_ui::runtime` now separates project-document mechanics

Doctor error findings fell from 28 to 26. Existing Browser, workspace runtime,
workspace test, and unrelated repository structural findings remain debt; this
batch did not broaden into them.

## Validation

- `effigy check:longhorn-consumer`: pass
- `cargo check -p nucleus-desktop`: pass
- `cargo test -p nucleus-desktop`: 56 passed
- `effigy desktop:check`: 0 errors; one pre-existing ProjectRail warning
- `effigy desktop:test`: 39 Bun tests and 2 mounted tests passed

## Next

Execute cards 030-032 as one Settings-shell batch. Keep page schemas and
effects in Nucleus; use Longhorn only for registry and session mechanics.
