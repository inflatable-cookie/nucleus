# 281 Provider Read-Intent Nucleusd Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../074-provider-read-intent-nucleusd-query.md`

## Purpose

Validate the provider read-intent `nucleusd` query lane.

## Acceptance Criteria

- [x] Focused provider read-intent `nucleusd` tests pass.
- [x] CLI parser tests pass.
- [x] `nucleusd` crate check passes.
- [x] Effigy selector smoke runs.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Doctor remains error-free.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleusd provider_read_intent -- --nocapture`
- `cargo test -p nucleusd cli_config -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleusd`
- `effigy server:query:provider-read-intent`
- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
- `rg "^## Next Task" -n README.md AGENTS.md docs -g '*.md'`
