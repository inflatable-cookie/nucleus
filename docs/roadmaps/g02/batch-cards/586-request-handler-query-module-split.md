# 586 Request Handler Query Module Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Split request-handler query routing so diagnostics additions do not keep
collecting in one broad module.

## Scope

- Move diagnostics query vocabulary/routing helpers into named modules.
- Keep the public request-handler surface stable.
- Avoid changing control API behavior.

## Acceptance Criteria

- [ ] `request_handler/queries.rs` is reduced enough to stop being the
  obvious collection point for every diagnostics domain.
- [ ] Domain-specific query helpers have named ownership.
- [ ] Existing diagnostics query tests still pass.

## Validation

- `cargo test -p nucleus-server request_handler -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
