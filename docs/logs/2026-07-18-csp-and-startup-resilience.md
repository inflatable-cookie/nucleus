# CSP And Startup Resilience

Date: 2026-07-18
Lane: g04 desktop contract integrity (card 216)

## Outcome

- webview CSP restored: `default-src 'self'`, ipc connect-src, data: images
  and fonts, inline styles for Svelte/CodeMirror — the backstop is in place
  before any panel grows markdown rendering
- startup seeding is fallible and idempotent: seeds run only when the local
  project record is absent, so restarts stop rewriting the durable store;
  a seed failure records an error instead of panicking through seven
  `.expect()`s
- new `desktop_startup_status` command surfaces posture to the UI:
  App.svelte shows a persistent error banner on seed failure and a quiet
  "fixture-backed" badge so the storage posture is no longer invisible

## Evidence

- desktop svelte-check 0 errors, bun tests green, workspace green
- CSP panel walk-through deferred to the operator's next live app launch
  (recorded on the card)

## Next

Card 217 (control-layer collapse and IO hygiene) is the final card in the
audit hardening band.
