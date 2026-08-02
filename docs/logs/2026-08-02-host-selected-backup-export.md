# Host-selected Backup Export

Date: 2026-08-02
Status: complete
Roadmap: g05.015, card 045

## Change

Nucleus now exports an inventoried operational backup through a native save
picker without exposing destination paths to the renderer or holding the
configuration authority mutex during interaction.

The picker result becomes one bounded, request-correlated, single-use target.
The authority re-lists the source, checks the exact digest, inspects bounded
bytes, asks Longhorn to re-encode the verified snapshot as `user-export`, then
uses Longhorn's existing verified durable publication path. A target that did
not exist when selected cannot be overwritten if it appears later.

Longhorn commit `3032545b3284d3af7f976a88827bb8c8f5c94513` adds the missing
canonical re-encoding primitive. Nucleus carries no ZIP vocabulary.

## Evidence

- six focused Nucleus config-operation fixtures pass
- exact archive id, domain evidence, and payload bytes survive export
- source mutation after inventory rejects without destination publication
- target correlation rejects duplicates and consumes once
- Settings and Rust checks pass
- exact clean-source Longhorn consumer audit passes
- desktop Svelte checks, 53 renderer tests, and production build pass

The native development app launches with the new command. The macOS
automation bridge still cannot attach to the hidden-restored development
window and reports `cgWindowNotFound`, so visual save-sheet observation remains
deferred to card 047's isolated native acceptance.

## Next Task

Card 046 defines and implements restore as a restart-safe offline transaction.
The live SQLite owner must never coexist with publication of restored database
bytes.
