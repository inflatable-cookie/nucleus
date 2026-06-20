# 594 Durable Dispatch Outcome Persistence Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Move embedded tests out of the durable dispatch outcome persistence module.

## Scope

- Move the `#[cfg(test)]` module into a sibling test file.
- Keep persistence behavior and assertions unchanged.
- Do not change durable dispatch outcome records.

## Acceptance Criteria

- [ ] The production module drops below the current god-file error threshold.
- [ ] Tests still run under the same module path.
- [ ] No persistence schema or authority changes are made.

## Validation

- `cargo test -p nucleus-server provider_durable_dispatch_outcome_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
