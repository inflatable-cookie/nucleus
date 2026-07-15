# Workspace Resource Target Resolution

Date: 2026-07-15
Lane: g04 multi-resource attachment and targeting

## Outcome

- added one host-owned resolver for explicit, configured-default, sole, zero,
  and ambiguous working-resource cases
- routed chat, task execution, editor, terminal, and review capture through it
- retained resolved resource ids in editor snapshots, terminal sessions, chat
  sessions, and immutable review evidence
- persisted panel target choices per project across remount and restart
- kept zero-resource terminal fallback at the authoritative host user's home
- left ordinary browser URL navigation resource-free and diff reads bound to
  their captured snapshot attribution
- removed operational default-root helpers and duplicate chat path resolution

## Evidence

- focused resolver, editor, terminal, review-snapshot, desktop workspace-config,
  and terminal IPC tests pass
- server and desktop Rust checks pass
- desktop Svelte and TypeScript checks pass

## Next

Add compact project resource management and show target controls only when
multiple compatible resources or repair require operator input.
