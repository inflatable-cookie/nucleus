# 068 Effigy Selector Inventory Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Represent Effigy selector discovery as sanitized project evidence.

## Scope

- Add records for Effigy enablement, manifest refs, selector names, selector
  kinds, and command-scope hints.
- Support root and multi-repo Effigy surfaces.
- Keep Effigy optional per project.
- Do not run Effigy commands yet.

## Acceptance Criteria

- [x] A project can represent no Effigy, root Effigy, and repo-scoped Effigy.
- [x] Selector inventory records are reference-only and sanitized.
- [x] Selector records can support later steward recommendations.

## Outcome

Added `nucleus-native-harness::effigy` for record-only Effigy integration and
selector inventory.

The records cover disabled, detected, enabled, missing-manifest, and unknown
states; root and repo scopes; sanitized manifest and evidence refs; selector
kinds; and command-scope hints. No Effigy command execution was added.

## Validation

- [x] `cargo test -p nucleus-native-harness effigy`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if selector discovery needs live Effigy execution before records can be
  named.
