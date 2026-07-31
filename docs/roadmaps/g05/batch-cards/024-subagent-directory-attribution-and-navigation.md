# 024 Subagent Directory Attribution And Navigation

Status: ready
Owner: Tom
Created: 2026-07-31
Milestone: `../007-structured-provider-work.md`
Depends on: card 023
Auto-start next card: yes

## Objective

Persist one operation-local child directory and navigate attributed work
without adding child-control authority.

## Acceptance

- [ ] snapshots fold through Swallowtail `SubagentDirectoryProjection`
- [ ] first-seen ordering and unknown placeholders survive restart
- [ ] main, known-child, and unknown activity remain distinguishable
- [ ] operation termination invents no child terminal state
- [ ] no spawn, steer, interrupt, resume, or delete action is exposed
