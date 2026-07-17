# 216 CSP And Startup Resilience

Status: planned
Owner: Codex
Updated: 2026-07-17
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

- [ ] CSP active, panels functional
- [ ] broken store shows an error screen, not a panic
- [ ] fixture posture visible; durable store not silently polluted

## Validation

- desktop manual smoke across panels
- `cargo test -p nucleus-desktop` (src-tauri)

## Stop Conditions

- stop before redesigning bootstrap/seeding flows beyond gating them
