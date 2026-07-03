# 493 Planning Capture Publication Diagnostics

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Expose read-only diagnostics for planning projection capture publication
readiness and stopped requests.

## Work

- [x] Add a read model over admission and stopped request records.
- [x] Report status counts, blocker counts, adapter-family counts, and evidence
  counts.
- [x] Preserve sanitized refs only.
- [x] Keep raw payloads and command output out of the diagnostic surface.

## Acceptance Criteria

- [x] Diagnostics are read-only and deterministic.
- [x] Blocked and accepted states are visible without executing effects.
- [x] No raw credential, provider, terminal, or command payload is exposed.

## Evidence

- `planning_capture_publication_stopped_request_diagnostics`
- `cargo test -p nucleus-server planning_capture_publication`
