# 277 Provider Read-Intent Serialized Envelope Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../073-provider-read-intent-serialized-control-envelope.md`

## Purpose

Validate the provider read-intent serialized control-envelope lane.

## Acceptance Criteria

- [x] Focused provider read-intent tests pass.
- [x] Control-envelope DTO tests pass.
- [x] Server crate check passes.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Doctor remains error-free.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server provider_read_intent -- --nocapture`
- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
- `rg "^## Next Task" -n README.md AGENTS.md docs -g '*.md'`
