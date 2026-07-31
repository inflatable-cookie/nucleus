# 024 Subagent Directory Attribution And Navigation

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../007-structured-provider-work.md`
Depends on: card 023
Auto-start next card: yes

## Objective

Persist one operation-local child directory and navigate attributed work
without adding child-control authority.

## Acceptance

- [x] snapshots fold through Swallowtail `SubagentDirectoryProjection`
- [x] first-seen ordering and unknown placeholders survive restart
- [x] main, known-child, and unknown activity remain distinguishable
- [x] operation termination invents no child terminal state
- [x] no spawn, steer, interrupt, resume, or delete action is exposed

## Evidence

- `subagent_directory` server fixtures cover reducer ordering, unknown
  placeholders, replacement, restart, terminal honesty, and durable selection.
- Agent Chat history and live events retain full operation-local directories.
- The transcript picker filters main or exact operation-local child activity;
  the route accepts only children present in the durable directory.
- The desktop exposes navigation only. No child-control command or affordance
  exists.
