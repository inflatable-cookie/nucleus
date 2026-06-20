# 593 Durable Dispatch Outcome Linkage Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Move embedded tests out of the durable executor dispatch outcome linkage module.

## Scope

- Move the `#[cfg(test)]` module into a sibling test file.
- Keep production code and assertions unchanged.
- Do not change dispatch outcome linkage behavior.

## Acceptance Criteria

- [ ] The production module drops below the current god-file error threshold.
- [ ] Tests still run under the same module path.
- [ ] No provider, dispatch, or task authority changes are made.

## Validation

- `cargo test -p nucleus-server provider_durable_executor_dispatch_outcome_linkage -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
