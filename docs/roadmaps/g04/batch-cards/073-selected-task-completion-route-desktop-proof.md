# 073 Selected Task Completion Route Desktop Proof

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Add a disposable desktop proof for explicit completion from an admitted route.

## Work

- [ ] Render route-backed completion readiness beside route admission.
- [ ] Require explicit operator action and expected revision before apply.
- [ ] Show command receipt and refreshed timeline evidence after apply.
- [ ] Add guard tests that prevent provider, SCM, planning, memory, and final UI
  effects.

## Acceptance Criteria

- [ ] The proof cannot complete from route status alone.
- [ ] The proof cannot complete from route admission alone.
- [ ] Stale-client protection remains visible.
- [ ] No rework, delegation, SCM, provider, planning, or memory controls are
  added.
