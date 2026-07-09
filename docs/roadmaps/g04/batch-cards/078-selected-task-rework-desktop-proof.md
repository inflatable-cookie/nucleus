# 078 Selected Task Rework Desktop Proof

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../016-selected-task-rework-from-review-outcome.md`

## Purpose

Render selected-task rework preparation inside the disposable workflow proof
modal.

## Work

- [x] Add the light TypeScript query adapter.
- [x] Render rework status, refusal, provenance refs, and no-effect flags beside
  route admission.
- [x] Keep any rework apply/schedule control disabled unless a later explicit
  command boundary exists.
- [x] Avoid widening the proof into final UI or durable client state.

## Acceptance Criteria

- [x] The proof stays inside the top-level modal launcher.
- [x] The UI cannot create a work item or schedule an agent.
- [x] `effigy desktop:check` passes.

## Result

The disposable task workflow modal now queries selected-task rework preparation
and renders status, refusal, route refs, review decision refs, reviewed work
refs, reviewed evidence refs, operator/revision context, and no-effect flags.

The proof keeps rework work-item creation unavailable and does not schedule
agents, mutate tasks, run providers, touch SCM/forge state, or create durable
client state.

## Validation

- `effigy desktop:check`
