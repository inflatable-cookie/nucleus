# 571 SCM Change Request Prep Adapter Neutrality

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../121-scm-capture-change-request-preparation-admission.md`

## Purpose

Keep change-request preparation admission SCM-adapter neutral.

## Scope

- Avoid Git-only commit/branch/push vocabulary in the admission record.
- Keep adapter label and workflow label explicit.
- Leave Git/convergence/other SCM mapping to later adapter lanes.

## Acceptance Criteria

- [x] Admission records use provider-neutral change-request language.
- [x] Adapter labels are explicit.
- [x] Workflow labels are explicit.
- [x] No Git-only assumptions are required for admission.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_adapter_neutrality -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
