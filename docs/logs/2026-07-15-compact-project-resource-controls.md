# Compact Project Resource Controls

Date: 2026-07-15
Lane: g04 multi-resource attachment and targeting

## Outcome

- added compact project-menu resource management for folder or Git attachment,
  default selection, location repair, and membership removal
- kept host, role, kind, and health visible while identifiers and branch
  metadata remain behind details
- added native directory selection without moving filesystem detection or
  mutation authority into the client
- added persisted per-project selectors to chat, editor, and terminal only
  when resource choice or repair needs attention
- close affected terminal sessions before resource mutation so no session
  retains a changed or removed working target
- migrated the legacy Nucleus seed resource to the embedded desktop authority
  used by the project and current resource controls

## Evidence

- focused resource command, terminal runtime, seed migration, and presentation
  tests pass
- desktop Svelte and TypeScript checks, production build, and Rust check pass
- formatting and diff hygiene pass

## Next

Validate the full zero-, one-, and multi-resource workflow across panels,
movement repair, persistence, and local or remote authority shapes.
