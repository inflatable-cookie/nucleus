# 492 Planning Capture Publication Stopped Request

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Persist a stopped publication/share request record without executing the
underlying SCM, forge, or provider effect.

## Work

- [x] Add request records for accepted publication/share admission.
- [x] Record adapter family, target refs, approval refs, evidence refs, and
  no-effect flags.
- [x] Preserve idempotency for duplicate request inputs.
- [x] Keep command execution and runner handoff deferred.

## Acceptance Criteria

- [x] Stopped requests are durable and inspectable.
- [x] Duplicate requests are controlled no-ops or explicit duplicates.
- [x] No real commit, snapshot, push, publish, forge mutation, provider
  execution, import, or task promotion is added.

## Evidence

- `crates/nucleus-server/src/provider_planning_capture_publication_stopped_request.rs`
- `crates/nucleus-server/src/provider_planning_capture_publication_stopped_request/`
- `cargo test -p nucleus-server planning_capture_publication`
