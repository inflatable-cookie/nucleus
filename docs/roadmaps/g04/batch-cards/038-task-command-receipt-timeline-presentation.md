# 038 Task Command Receipt Timeline Presentation

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../008-task-command-outcome-coherence.md`

## Purpose

Show command receipt and task timeline evidence together in the disposable
workflow proof surface.

## Work

- [x] Keep command receipt status visible after mutation.
- [x] Show refreshed task timeline entry count and source refs near the
  receipt.
- [x] Avoid raw command payloads and provider payloads.
- [x] Add focused component guard coverage.

## Acceptance Criteria

- [x] The user can see that a task command was accepted or rejected.
- [x] The refreshed timeline/workflow evidence is visibly associated with the
  command outcome.
- [x] No raw payload, provider execution, SCM/forge, review, memory, or planning
  apply surface is added.

## Result

- Added a task-command outcome evidence section to the disposable proof panel.
- Kept sanitized command receipt id, status, action, family, and submitted
  revision visible after command responses.
- Associated command outcomes with refreshed task timeline counts, timeline
  refs, task activity, guidance refs, and command evidence counts.
- Added guard coverage for receipt/timeline presentation and raw payload
  exclusions.
