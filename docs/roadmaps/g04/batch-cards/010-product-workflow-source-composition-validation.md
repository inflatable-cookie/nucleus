# 010 Product Workflow Source Composition Validation

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Validate the source-composed product workflow summary and choose the next
bounded product lane.

## Work

- [ ] Run focused server, CLI, Effigy, and desktop product workflow checks.
- [ ] Run docs QA, Northstar QA, format/diff checks, package checks, and
  doctor.
- [ ] Compare remaining gaps against `docs/roadmaps/deferred-lanes.md`.
- [ ] Choose the next lane from task-backed agent loop hardening, SCM handoff
  UX, planning/research UX, memory review UX, or client workflow composition.

## Acceptance Criteria

- [ ] Validation passes or failures are documented.
- [ ] Remaining gaps are product-significant, not invented busywork.
- [ ] The next lane is bounded and does not reopen deferred subsystem work by
  default.
