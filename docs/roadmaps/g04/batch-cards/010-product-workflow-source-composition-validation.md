# 010 Product Workflow Source Composition Validation

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Validate the source-composed product workflow summary and choose the next
bounded product lane.

## Work

- [x] Run focused server, CLI, Effigy, and desktop product workflow checks.
- [x] Run docs QA, Northstar QA, format/diff checks, package checks, and
  doctor.
- [x] Compare remaining gaps against `docs/roadmaps/deferred-lanes.md`.
- [x] Choose the next lane from task-backed agent loop hardening, SCM handoff
  UX, planning/research UX, memory review UX, or client workflow composition.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] Remaining gaps are product-significant, not invented busywork.
- [x] The next lane is bounded and does not reopen deferred subsystem work by
  default.

## Validation

Passed:

- `cargo fmt --all --check`
- `cargo test -p nucleus-server product_workflow_summary -- --nocapture`
- `cargo test -p nucleusd product_workflow -- --nocapture`
- `cargo test -p nucleus-desktop product_workflow -- --nocapture`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `cargo check -p nucleus-desktop`
- `effigy server:query:product-workflow-summary`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

`effigy doctor` is warning-only with existing god-file findings.

## Decision

Continue g04 with task workflow drilldown and handoff readiness.

The source-composed summary is now useful as a project-level overview, but the
next product gap is actionability: a ready task, review ref, or SCM readiness
ref needs a bounded drilldown path that explains timeline, runtime, review, and
handoff evidence without mutating tasks, providers, memory, SCM, or UI state.

Do not reopen accepted-memory active apply, planning active apply, provider
live-read expansion, or Convergence backend execution. Those remain deferred
until a visible workflow needs them.
