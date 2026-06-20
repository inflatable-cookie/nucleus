# 592 Health Rebaseline Second Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Re-run the health checks after the second health pass and decide whether SCM
adapter-plan work can resume.

## Scope

- Record current doctor counts.
- Update the implementation gap index.
- Resume roadmap 123 only if the remaining doctor state is acceptable.
- Otherwise name the next health gate explicitly.

## Acceptance Criteria

- [ ] `effigy doctor` state is recorded.
- [ ] Remaining god-file errors are either reduced or intentionally deferred.
- [ ] Roadmap 123 is either resumed or remains paused behind a named next gate.
- [ ] Full validation has run after the health pass.

## Validation

- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo check --workspace`
- `cargo test --workspace`
- `git diff --check`
