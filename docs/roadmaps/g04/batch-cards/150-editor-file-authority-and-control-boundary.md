# 150 Editor File Authority And Control Boundary

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../028-initial-code-editor-vertical-slice.md`
Auto-start next card: yes

## Objective

Implement the Rust-owned project file discovery, snapshot read, and
revision-checked save boundary required by the first Editor panel.

## Governing Refs

- `../../../contracts/006-workspace-layout-contract.md`
- `../../../contracts/007-server-boundary-contract.md`
- `../../../contracts/017-engine-host-authority-contract.md`
- `../../../specs/006-initial-code-editor-vertical-slice.md`
- `../../../research/translation-memos/editor-substrate-selection.md`

## Scope

- add focused Rust modules for editor file refs, discovery policy, snapshots,
  content revisions, read, and save
- resolve the authoritative project root from server-owned project state
- enforce root containment, safe relative display paths, ignore/hard-exclusion
  policy, text classification, size bounds, and write capability
- expose typed list/read queries and revision-checked save command through the
  server control boundary and serializable DTOs
- return the new accepted snapshot after save
- keep raw absolute paths, binary contents, and unbounded traversal out of DTOs

## Ordered Steps

1. Add domain/DTO shapes for opaque file ref, discovery entry, file snapshot,
   save request, accepted save, conflict, and refusal.
2. Add project-root resolution and path admission helpers with traversal and
   symlink-escape coverage.
3. Add bounded ignore-aware discovery and text/size classification.
4. Add snapshot read and deterministic opaque content revision generation.
5. Add revision-checked safe replacement with explicit stale conflict.
6. Route list/read/save through request handler, control DTO, and desktop
   adapter boundaries without adding UI.
7. Add focused round-trip, policy, conflict, and persistence-independent tests.

## Acceptance Criteria

- discovery returns only admitted project-relative text files and opaque refs
- read revalidates the ref and returns the contracted snapshot fields
- save requires the exact accepted revision and cannot escape the project root
- stale save returns conflict without modifying the file
- accepted save returns a new revision and exact written content
- control envelopes round-trip list/read/save without exposing absolute paths
- no Svelte or CodeMirror work enters this card

## Validation

- `effigy check:rust`
- `effigy test -- --package nucleus-server --package nucleus-workspaces`
- `git diff --check`

## Closure Evidence

- focused tests covering admitted read/save, stale conflict, traversal,
  symlink escape, ignored/binary/oversized files, and DTO round trips
- changed-file inventory showing the boundary remains in focused Rust modules
- no runtime effect, SCM mutation, or UI state introduced

## Stop Conditions

- project-root authority cannot be resolved from existing project state
- safe containment requires following an uncontracted remote-host path model
- the implementation would expose absolute paths or accept client path
  authority
- safe replacement semantics cannot be proven on the supported desktop host

## Next

Auto-start card 151 after this card closes. Stop instead if the implemented
boundary changes the promoted snapshot or save contract.

## Outcome

- added a focused `nucleus-server` editor-file authority module
- bounded discovery respects Git ignore rules and hard exclusions, admits only
  UTF-8 text up to 2 MiB, and returns opaque path hashes
- read/save re-resolve the file inside the canonical project root
- save requires an exact BLAKE3 content revision, preserves permissions, uses
  same-directory replacement, and returns the new snapshot
- typed serializable Tauri commands carry list/read/save results directly; the
  generic command receipt was not extended because it cannot return the new
  accepted snapshot
- focused happy-path, exclusion, invented-ref, and stale-conflict tests pass
