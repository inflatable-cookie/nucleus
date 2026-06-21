# 061 G03 Validation Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../016-g03-health-validation-rebaseline.md`

## Purpose

Run the validation surface for the completed G03 record tranche.

## Acceptance Criteria

- [x] Convergence focused tests pass or blockers are recorded.
- [x] Package check passes or blockers are recorded.
- [x] Docs and Northstar QA pass or blockers are recorded.
- [x] `Next Task` appears only in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server convergence_publication -- --nocapture`
- `cargo test -p nucleus-server adapter_neutral_change_request_chain -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `rg -n '^## Next Task' README.md AGENTS.md docs -g '*.md'`
