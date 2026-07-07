# 038 Task Command Receipt Timeline Presentation

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../008-task-command-outcome-coherence.md`

## Purpose

Show command receipt and task timeline evidence together in the disposable
workflow proof surface.

## Work

- [ ] Keep command receipt status visible after mutation.
- [ ] Show refreshed task timeline entry count and source refs near the
  receipt.
- [ ] Avoid raw command payloads and provider payloads.
- [ ] Add focused component guard coverage.

## Acceptance Criteria

- [ ] The user can see that a task command was accepted or rejected.
- [ ] The refreshed timeline/workflow evidence is visibly associated with the
  command outcome.
- [ ] No raw payload, provider execution, SCM/forge, review, memory, or planning
  apply surface is added.
