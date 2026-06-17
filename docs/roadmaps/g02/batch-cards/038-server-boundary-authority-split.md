# 038 Server Boundary Authority Split

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../012-health-and-authority-surface-reset.md`

## Purpose

Reduce broad server-boundary authority pressure by pointing durable rules at
focused contracts.

## Scope

- Inspect `docs/contracts/007-server-boundary-contract.md` for sections now
  owned by focused contracts.
- Replace duplicated authority prose with concise redirects where safe.
- Update contract index and architecture docs if ownership changes.
- Preserve historical context where needed.
- Do not create new behavior or new implementation cards.

## Acceptance Criteria

- Server boundary reads as a host/API boundary, not the system core.
- Orchestration, host authority, runtime receipts, checkpoints, and SCM rules
  point to focused contracts.
- No durable rule is deleted without a new canonical home.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if ownership cannot be made clear without changing the underlying
  architecture decision.

## Outcome

Completed 2026-06-17.

`docs/contracts/007-server-boundary-contract.md` now identifies itself as the
host/API boundary and points durable authority to focused owners for host
authority, orchestration, conversation timelines, runtime receipts,
checkpoints, engine/orchestration crate boundaries, SCM/forge, storage, and
harness adapters.

The contract index, contracts front door, and architecture inventory now carry
the same split so future work does not treat the broad server boundary as the
system core.
