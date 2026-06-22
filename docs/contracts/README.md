# Contracts

Contracts define durable rules and interfaces.

## Current Contracts

- `001-working-rules.md`
- `002-harness-adapter-contract.md`
- `003-project-identity-contract.md`
- `004-model-routing-contract.md`
- `005-task-contract.md`
- `006-workspace-layout-contract.md`
- `007-server-boundary-contract.md`
- `008-storage-state-persistence-contract.md`
- `009-adapter-registry-contract.md`
- `010-agent-session-lifecycle-contract.md`
- `011-scm-forge-sync-contract.md`
- `012-native-harness-runtime-contract.md`
- `013-shared-memory-contract.md`
- `014-structured-project-planning-contract.md`
- `015-deep-research-contract.md`
- `016-effigy-project-integration-contract.md`
- `017-engine-host-authority-contract.md`
- `018-orchestration-contract.md`
- `019-conversation-timeline-contract.md`
- `020-runtime-receipt-contract.md`
- `021-checkpoint-diff-contract.md`
- `022-engine-orchestration-boundary-contract.md`
- `023-task-backed-agent-workflow-contract.md`
- `024-harness-mediation-tool-projection-contract.md`
- `025-goal-loop-next-task-contract.md`
- `026-open-ended-planning-conversation-contract.md`
- `027-provider-auth-forge-execution-contract.md`
- `contract-index.md`

## Promotion Rule

Research and specs can be provisional. Contracts should only contain rules the
repo is ready to enforce or design against.

## Authority Split

`007-server-boundary-contract.md` is now the host/API boundary. Durable system
authority belongs to the focused contracts listed in `contract-index.md`,
especially `017` through `025`.

## Current Gaps

See `contract-index.md` for needed contracts found during the 2026-06-17
reassessment.
