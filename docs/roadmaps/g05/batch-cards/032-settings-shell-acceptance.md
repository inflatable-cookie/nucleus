# 032 Settings Shell Acceptance

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../010-longhorn-settings-shell.md`
Depends on: card 031
Auto-start next card: yes

## Objective

Close the Settings shell with deterministic and native lifecycle evidence.

## Acceptance

- [x] apply, reset, stale conflict, close guard, remount, and restart pass
- [x] failed writes never present as applied
- [x] hidden pages leave no dead navigation or stale deep link
- [x] the normal path remains compact and understandable

## Validation

- [x] focused Rust, desktop, Svelte, accessibility, and docs selectors pass
- [x] separately gated native visual acceptance passes

## Stop Conditions

- stop if any setting bypasses host or domain authorization

## Evidence

- native modal navigation, immediate apply, staged apply, close guard, remount,
  lazy page loading, and Browser suppression passed
- native proof found and fixed the stock single-webview Tauri command mismatch
  and a shared-domain sibling-scope invalidation gap
- exact Longhorn consumer evidence passes at commit
  `58883b903a211956eef659ba19ff0bc57fe98da5`, selected-tree SHA-256
  `b46803e7a208ceca39e7f394d4d046a157592dc6a783fa055a0814ffa6df9053`
- native Appearance apply -> General immediate write -> General reset ->
  Appearance reset passed without a false stale conflict
- restart restored the compact density and enabled fixture-status defaults
