# Nucleus Docs

Northstar authority surface for Nucleus.

## Start Here

- `vision/README.md`
- `architecture/README.md`
- `contracts/README.md`
- `specs/README.md`
- `roadmaps/README.md`
- `logs/README.md`
- `research/README.md`

Strict posture also starts from:

- `contracts/001-working-rules.md`
- `contracts/034-agent-instruction-surface-contract.md`

## Working Rule

- `vision/` owns long-horizon outcomes and constraints
- `architecture/` records realized structure and inventories
- `contracts/` hold durable rules and boundaries
- `specs/` hold provisional planning until promotion
- `roadmaps/` sequence work and own the live `## Next Task` pointer
- `logs/` record decisions and evidence
- `research/` holds external evidence before promotion

Keep the live next-task pointer only in `docs/roadmaps/README.md`.

## Current Lane

Generation `g05` is active and largely complete. The product shell-inward pass
through workspace composition, Agent Chat, Longhorn adoption, settings,
commands, notifications, backup and restore, shell cohesion, and plan-decision
Agent Chat is closed.

The current execution focus is the agent orchestration product checkpoint
(`roadmaps/g05/027-agent-orchestration-product-checkpoint.md`):

- phases 1-3 are merged on main: run registry, operator-dispatched runs,
  worktree authority, fleet panel, delivery pipeline, review surface, forge PR
  lane, orchestrator designation, and delegation tools
- contract `033-orchestration-runs-and-delegation-authority-contract.md` stays
  draft until operator live checkpoint and any phase-4 steering decision
- real forge routes still report `ProviderUnavailable` until a provider `027`
  lane lands

The independent g05 maintenance task at
`roadmaps/g05/026-northstar-instruction-and-language-quality-audit.md` is
complete: Rust 1.95 is the workspace MSRV, both language-quality recorders are
finalized with their retained findings, and the AGENTS surface leads with
project orientation. It did not select g06 or satisfy the orchestration product
checkpoint.

Canonical lane refs:

- `roadmaps/README.md` — live next task
- `roadmaps/g05/README.md` — generation roadmap and approved frontier
- `research/translation-memos/agent-orchestration-lane.md` — lane architecture
  and phase model
- `roadmaps/long-term-plan.md` — multi-generation horizon model
- `roadmaps/deferred-lanes.md` — valid return queue

## Guardrail

Do not resume deferred lanes, provider expansion, remote transport, secondary
windows, or broad automation until a current product workflow proves the need.
See `roadmaps/deferred-lanes.md`.
<!-- northstar:lifecycle:begin schema=northstar.lifecycle.projection.v2 digest=sha256:905c979981e2ba75817f34f590824bc13b8aaca09a647c281c39a2afb5a8e6b5 -->
| Generation | Disposition | Runway state |
| --- | --- | --- |
| g06 | open | planning_required |
| Task | Status | Stage | Revision | Record digest |
| --- | --- | --- | --- | --- |
| g06.001 | complete | none | 8 | sha256:6fe5c4a39d04302298dc0ee8cdb13757e88d7391f78eea63ebd0c5697ccdae74 |
| g06.002 | complete | none | 8 | sha256:ba9dbbe729cff5023975ff61fe5678e16863835882dff837a6f165d8b94f7d63 |
<!-- northstar:lifecycle:end -->
