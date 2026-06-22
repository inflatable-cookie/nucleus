# 261 Provider Read-Intent Projection Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../069-provider-read-intent-projection-control.md`

## Purpose

Validate generic stopped provider read-intent projection/control records.

## Acceptance Criteria

- [x] Focused read-intent projection tests pass.
- [x] Server crate check passes.
- [x] Doctor remains error-free.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server read_intent_projection -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg "^## Next Task" -n README.md AGENTS.md docs`
