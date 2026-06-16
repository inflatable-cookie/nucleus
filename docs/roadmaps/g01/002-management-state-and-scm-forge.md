# 002 Management State And SCM Forge

Status: complete-first-pass
Owner: Tom
Updated: 2026-06-16

## Goal

Define repo-backed project management projection, SCM and forge abstraction,
task links, work sessions, branch/worktree policy, credentials, webhooks,
review workflows, and non-Git SCM semantics.

## Scope

- Hybrid server-local state plus repo-backed projection.
- Projection file model, validation, and migration policy.
- SCM and forge adapter boundaries.
- Sync observations, task links, conflicts, reviews, branches, worktrees, and
  work sessions.
- Credential and webhook verification boundaries.
- Implementation readiness plan for SCM/forge adapters.

## Out Of Scope

- SCM command implementation.
- Forge API implementation.
- Webhook endpoint implementation.
- Production credential store selection.
- UI conflict resolution.

## Execution Plan

- [x] Promote committable project-management state model.
- [x] Define projection records, schema validation, and migration posture.
- [x] Define provider-neutral SCM/forge surfaces without assuming Git-only
  commit semantics.
- [x] Define branch/worktree session management for in-app agent workflows.
- [x] Define conflict, review, credential, and webhook boundaries.
- [x] Prepare SCM/forge implementation readiness constraints.

## Acceptance Criteria

- [x] Project, task, storage, and SCM/forge contracts separate server-local
  state from shared projection state.
- [x] SCM terminology does not assume every system has Git-style authoritative
  commits.
- [x] Worktree/branch workflows are represented as policy, not UI behavior.
- [x] Forge identities do not replace Nucleus task or project identity.
- [x] Credentials and webhooks retain sanitized evidence only.

## Cards

- `docs/roadmaps/g01/batch-cards/018-git-backed-project-management-state.md`
- `docs/roadmaps/g01/batch-cards/022-management-projection-file-model.md`
- `docs/roadmaps/g01/batch-cards/023-projection-storage-rust-surface-boundaries.md`
- `docs/roadmaps/g01/batch-cards/024-projection-schema-validation-and-migration-policy.md`
- `docs/roadmaps/g01/batch-cards/025-scm-and-forge-adapter-surface-boundaries.md`
- `docs/roadmaps/g01/batch-cards/026-scm-forge-sync-observation-and-task-link-policy.md`
- `docs/roadmaps/g01/batch-cards/027-scm-forge-implementation-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/028-scm-forge-credential-and-webhook-verification-boundary.md`
- `docs/roadmaps/g01/batch-cards/029-branch-worktree-session-management-policy.md`
- `docs/roadmaps/g01/batch-cards/030-scm-forge-conflict-and-review-workflow-policy.md`
- `docs/roadmaps/g01/batch-cards/031-scm-forge-adapter-implementation-readiness-plan.md`

## Planning Gaps

- Management branch versus main-branch sync remains implementation-phase.
- Forge issue mirroring remains implementation-phase.
- Webhook versus polling refresh remains implementation-phase.
- Convergence-style publication fixtures need implementation-roadmap coverage.
