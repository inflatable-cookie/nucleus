# 529 Disposable UI Root Effigy Launch

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../121-disposable-planning-research-ui-proof.md`

## Purpose

Make the current disposable proof client/server workflow launchable from the
repository root through Effigy, if the existing app shape supports it.

## Work

- [x] Inspect current desktop/client tasks and dependencies.
- [x] Add or adjust the narrowest Effigy selector needed to launch the proof.
- [x] Keep the selector proof-oriented and avoid adding package scripts that
  duplicate Effigy routing.

## Acceptance Criteria

- [x] The proof launch path is documented through Effigy.
- [x] The selector does not imply a production UI contract.
- [x] No server authority, mutation, or provider execution behavior changes.

## Evidence

- Existing root selectors cover the proof launch/check path:
  `desktop:dev`, `desktop:web:dev`, `desktop:check`, and `desktop:build`.
- No `package.json` Effigy mirror scripts were added.
