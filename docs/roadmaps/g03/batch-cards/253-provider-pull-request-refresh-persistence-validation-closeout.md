# 253 Provider Pull-Request Refresh Persistence Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../067-stopped-provider-pull-request-refresh-persistence.md`

## Purpose

Validate stopped provider PR/MR refresh persistence/control records.

## Acceptance Criteria

- [x] Focused PR/MR refresh persistence tests pass.
- [x] Server crate check passes.
- [x] Doctor remains error-free.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server pull_request_refresh_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg "^## Next Task" -n README.md AGENTS.md docs`
