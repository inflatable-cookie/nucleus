# Project Resource Foundation Closeout

Date: 2026-07-15
Lane: g04 project resource foundation

## Outcome

- replaced the client project summary with sanitized resource-aware records
- preserved resource identity, kind, role, authority host, health, and defaults
- removed full host paths from the desktop control payload
- added pure mutation admission for actor, revision, kind, and host authority
- made unknown wire resource kinds fail closed
- moved chat and editor filesystem lookup off the legacy location summary
- validated resource-free, folder, Git, multi-resource, and remote-host shapes

## Evidence

- focused `nucleus-projects`, `nucleus-server`, and desktop-host tests pass
- isolated `cargo check --workspace` passes
- Svelte diagnostics report zero errors and zero warnings
- desktop production build passes
- docs QA passes

## Next

Add server-owned project lifecycle commands and receipts. Keep name-only
creation free of filesystem and Git fields; keep destructive lifecycle impact
explicit.
