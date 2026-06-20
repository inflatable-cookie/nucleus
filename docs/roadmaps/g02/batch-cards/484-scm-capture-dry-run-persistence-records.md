# 484 SCM Capture Dry Run Persistence Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../104-scm-capture-dry-run-planning-persistence.md`

## Purpose

Create persistence records for SCM capture dry-run planning output.

## Scope

- Persist sanitized dry-run plan items.
- Retain refs, labels, status, blockers, and evidence refs.
- Block raw material and external-effect requests.
- Do not execute SCM, forge, provider, callback, interruption, or recovery
  effects.

## Acceptance Criteria

- [x] Dry-run plan items produce persistence records.
- [x] Persisted records contain refs only.
- [x] Effect-requesting inputs are blocked.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_persistence_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
