# 218 Forge Network Rebaseline Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../060-forge-network-stopped-runner-health-boundary-rebaseline.md`

## Purpose

Close the forge network stopped-runner health and boundary rebaseline.

## Acceptance Criteria

- [x] Focused forge network execution tests pass.
- [x] Focused stopped PR runner tests pass.
- [x] Server crate check passes after the preceding outcome lane.
- [x] Doctor remains error-free after the preceding outcome lane.
- [x] Docs QA passes after the preceding outcome lane.
- [x] Northstar QA passes after the preceding outcome lane.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `cargo test -p nucleus-server forge_network_execution -- --nocapture`
- `cargo test -p nucleus-server forge_pull_request_runner -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg "^## Next Task" -n README.md AGENTS.md docs`
