# 223 Provider Credential Status Refresh Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../061-stopped-provider-credential-status-refresh-control.md`

## Purpose

Validate stopped provider credential-status refresh/control records.

## Acceptance Criteria

- [x] Focused credential-status refresh tests pass.
- [x] Server crate check passes.
- [x] Doctor remains error-free.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server forge_credential_status_refresh -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg "^## Next Task" -n README.md AGENTS.md docs`
