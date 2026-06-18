# 093 SCM Session Runtime Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../022-scm-working-session-runtime.md`

## Purpose

Validate and close SCM working session runtime records.

## Scope

- Run focused SCM, engine, and docs validation.
- Confirm provider-neutral vocabulary.
- Advance to client diagnostics read models.

## Acceptance Criteria

- [x] SCM session cards are complete or rehomed.
- [x] Git and non-Git workflows remain representable.
- [x] Next ready card points to diagnostics read models.

## Outcome

- Validated SCM session command records, Git admission, Convergence
  vocabulary, engine work-item linkage, docs, and roadmap pointer state.
- Advanced the next ready card to diagnostics read models.

## Validation

- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo test -p nucleus-engine scm`
- [x] `cargo test -p nucleus-engine task_work`
- [x] `cargo test -p nucleus-engine change_request`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if working-copy mutation must be implemented first.
