# Nucleus Docs

This is the Northstar authority surface for nucleus.

## Current Posture

Strict from start.

The repo uses:

- `vision/README.md` for long-horizon intent
- `architecture/README.md` for system shape and inventories
- `contracts/README.md` for durable rules and interfaces
- `specs/README.md` for provisional planning
- `roadmaps/README.md` for sequenced work
- `logs/README.md` for decisions and evidence
- `research/README.md` for external evidence before promotion

## Current Lane

`g02` orchestration and engine core.

Current planning artifacts:

- `logs/2026-06-17-stocktake.md`
- `logs/2026-06-17-g02-rollover.md`
- `roadmaps/long-term-plan.md`
- `roadmaps/reassessment-decision-queue.md`
- `roadmaps/g02/001-orchestration-and-engine-boundary.md`
- `roadmaps/g02/002-event-store-persistence-hardening.md`
- `roadmaps/g02/003-engine-task-command-boundary.md`
- `roadmaps/g02/004-task-timeline-and-history-projection.md`
- `roadmaps/g02/005-runtime-receipts-and-effect-reactors.md`
- `roadmaps/g02/006-checkpoint-and-diff-foundation.md`
- `roadmaps/g02/007-management-projection-sync-foundation.md`
- `roadmaps/g02/008-scm-forge-driver-runway.md`
- `roadmaps/g02/009-harness-runtime-target-selection.md`
- `roadmaps/g02/010-client-protocol-and-host-transport-runway.md`
- `roadmaps/g02/011-codex-app-server-runtime-runway.md`
- `specs/004-display-window-surface-layout.md`
- `architecture/t3-code-comparison.md`
- `architecture/architecture-gap-index.md`
- `architecture/implementation-gap-index.md`

## Guardrail

Do not build provider runtime, remote transport, or UI timeline behavior until
SCM driver contracts, harness runtime target selection, and client protocol
transport have moved into the active implementation lane.
