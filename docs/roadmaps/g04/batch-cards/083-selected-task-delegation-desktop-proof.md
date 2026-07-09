# 083 Selected Task Delegation Desktop Proof

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../017-selected-task-delegation-scheduling-admission.md`

## Purpose

Render selected-task delegation scheduling admission inside the disposable
workflow proof modal.

## Work

- [ ] Add the light TypeScript query adapter.
- [ ] Render admission status, refusal, source refs, candidate work-item refs,
  and no-effect flags beside action readiness and route admission.
- [ ] Keep any provider/run control disabled unless a later explicit command
  boundary exists.
- [ ] Avoid widening the proof into final UI or durable client state.

## Acceptance Criteria

- [ ] The proof stays inside the top-level modal launcher.
- [ ] The UI cannot start provider execution or mutate SCM/forge state.
- [ ] `effigy desktop:check` passes.
