# New Chat And Promotion

Date: 2026-07-18
Lane: g04 transient chat and promotion (card 195)

## Outcome

- the project rail gained a New Chat button: one click creates and
  focuses a transient resource-free project, no prompts
- transient chats render in their own quiet Chats group below the named
  rail, each with Keep (promote as-is) and Name (promote with a name)
  actions; a panel-guard test pins the rail exclusion
- durable-child admission per spec 012: task and goal creation on a
  transient project auto-promote it in place first (receipted as
  `promote` by `system:durable-child-admission`), and resource attachment
  flips retention durable inside its own mutation — a durable child can
  never be orphaned by transient expiry
- resource-free chat now works: the codex session falls back to the host
  home directory as an honest read-only working context, mirroring the
  terminal's zero-resource fallback (previously chat refused with
  "attach a folder", which would have made New Chat dead on arrival)

## Evidence

- workspace, desktop svelte-check, and bun tests green; panel guard
  updated to pin the new rail invariants
- live-app walkthrough (New Chat, keep/name, auto-promote) belongs to
  card 196 validation

## Next

Card 196: transient chat validation — restart, expiry, promotion, task
creation, and resource attachment behavior end to end.
