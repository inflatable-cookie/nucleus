# 216 CSP And Startup Resilience

Status: completed
Owner: Claude
Updated: 2026-07-18
Milestone: `../047-desktop-contract-integrity.md`
Auto-start next card: no

## Objective

Restore the webview CSP backstop and make desktop startup fail soft.

## Steps

- set strict CSP in `apps/desktop/src-tauri/tauri.conf.json`
  (`default-src 'self'`; style-src as panels require); verify all panels
- replace startup seeding `.expect()` chains with an error state surfaced in
  the UI
- surface the fixture-backed posture in the UI, and stop re-seeding fixture
  data into the durable user store on every launch

## Acceptance

- [x] CSP set: `default-src 'self'` with ipc connect-src, data: images and
  fonts, inline styles for Svelte/CodeMirror; operator to confirm all
  panels render on next app launch (needs the live app)
- [x] broken store shows a persistent error banner via the new
  `desktop_startup_status` command instead of an `.expect()` panic chain
- [x] fixture posture shown as an unobtrusive badge; seeding runs only when
  the local project record is absent — restart no longer rewrites the
  durable store

## Validation

- desktop manual smoke across panels
- `cargo test -p nucleus-desktop` (src-tauri)

## Stop Conditions

- stop before redesigning bootstrap/seeding flows beyond gating them
