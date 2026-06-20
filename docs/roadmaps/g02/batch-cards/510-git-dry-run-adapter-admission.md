# 510 Git Dry Run Adapter Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../109-git-scm-capture-dry-run-adapter-proof.md`

## Purpose

Map provider-neutral dry-run execution capability records to Git dry-run command
descriptors.

## Scope

- Require ready dry-run execution capability.
- Require Git adapter label.
- Keep non-Git adapters visible as unsupported.

## Acceptance Criteria

- [x] Ready Git dry-run capabilities map to command descriptors.
- [x] Non-Git adapters are unsupported, not coerced.
- [x] Missing adapter state is repair-required.
- [x] No Git mutation authority is granted.

## Validation

- `cargo test -p nucleus-server git_dry_run_adapter_admission -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
