# 569 SCM Change Request Prep Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../121-scm-capture-change-request-preparation-admission.md`

## Purpose

Define change-request preparation admission records from accepted SCM capture
review decisions.

## Scope

- Admit only persisted accepted decisions.
- Preserve readiness, workflow, repo, and evidence refs.
- Keep records adapter-neutral.

## Acceptance Criteria

- [x] Accepted persisted decisions become admitted preparation candidates.
- [x] Readiness and workflow refs are preserved.
- [x] Repo refs are preserved without assuming Git-only workflow terms.
- [x] Admission does not execute SCM or forge effects.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_admission_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
