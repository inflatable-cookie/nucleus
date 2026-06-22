# 265 Provider Read-Intent Query Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../070-provider-read-intent-query-composition.md`

## Purpose

Validate provider read-intent query composition.

## Acceptance Criteria

- [x] Focused read-intent query tests pass.
- [x] Server crate check passes.
- [x] Doctor remains error-free.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server read_intent_query -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg "^## Next Task" -n README.md AGENTS.md docs`
