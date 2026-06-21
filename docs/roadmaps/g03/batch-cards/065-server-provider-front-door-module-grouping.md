# 065 Server Provider Front-Door Module Grouping

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../017-server-provider-front-door-consolidation.md`

## Purpose

Move adapter-neutral and Convergence provider modules behind grouped server
provider fronts without changing behavior.

## Acceptance Criteria

- [x] Root `lib.rs` has fewer flat provider module/re-export entries.
- [x] Focused source files remain separate.
- [x] Existing public types/functions remain reachable through re-exports.
- [x] No execution behavior is added.

## Validation

- `cargo test -p nucleus-server adapter_neutral_change_request_chain -- --nocapture`
- `cargo test -p nucleus-server convergence_publication -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
