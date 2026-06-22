# 269 Provider Read-Intent Control Boundary Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../071-provider-read-intent-control-boundary.md`

## Purpose

Validate the provider read-intent control boundary and close the lane.

## Acceptance Criteria

- [x] Focused provider read-intent handler test passes.
- [x] Existing provider read-intent query tests still pass.
- [x] Server crate check passes.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Doctor remains error-free.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server provider_read_intent -- --nocapture`
- `cargo test -p nucleus-server read_intent_query -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg "^## Next Task" -n README.md AGENTS.md docs`
- `effigy doctor`
