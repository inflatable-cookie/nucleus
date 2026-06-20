# 589 Request Handler SCM Diagnostics Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Split the new request-handler SCM diagnostics test submodule that still crosses
the god-file error threshold after the first health pass.

## Scope

- Split `request_handler/tests/diagnostics_queries/scm.rs` by SCM diagnostics
  family.
- Keep assertions and fixture behavior unchanged.
- Do not change production diagnostics routing.

## Acceptance Criteria

- [ ] The SCM diagnostics request-handler tests no longer sit in one
  error-sized file.
- [ ] Dry-run, workflow/review, and change-request-prep tests have clear file
  ownership.
- [ ] No diagnostics behavior changes are introduced.

## Validation

- `cargo test -p nucleus-server request_handler -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
