# Convergence SCM Shape

Status: active
Owner: Tom
Updated: 2026-06-17

## Purpose

Capture the Convergence concepts that matter to the Nucleus SCM adapter
boundary.

Convergence is a local reference, not a dependency. Nucleus should learn from
its object model without making Convergence semantics mandatory for other SCMs.

## Source Evidence

Reference paths:

- `../convergence/README.md`
- `../convergence/docs/architecture/01-concepts-and-object-model.md`
- `../convergence/docs/architecture/02-repo-gates-lanes-scopes.md`

Observed Convergence terms:

- `snap`: immutable workspace state capture
- `publish`: submit a chosen snap to a gate within a scope
- `bundle`: gate output after coalescing publications or upstream bundles
- `promote`: move a bundle to a downstream gate after policy checks
- `release`: designate an allowed bundle for consumption
- `gate`: policy boundary for intake, checks, coalescing, and promotability
- `scope`: branch-like depth track through the gate graph
- `lane`: breadth partition for ownership, visibility, and integration
- `superposition`: conflict preserved as data

## Translation For Nucleus

Nucleus must model SCM workflow semantics, not only object labels.

| Nucleus concept | Convergence shape | Git-like shape |
| --- | --- | --- |
| Local capture | snap | commit, staged commit, working tree checkpoint |
| Shared authority transition | publish to scope/gate | push commit or branch |
| Review boundary | gate policy, bundle, promotion | pull request or merge request |
| Isolation track | scope | branch |
| Integration result | bundle or promoted bundle | merge commit, squash commit, rebase result |
| Release boundary | release from an allowed gate | tag/release from selected commit |

This means `commit`, `branch`, `push`, `pull request`, and `merge` are not
universal Nucleus core nouns. They are provider-specific names for a subset of
SCM and forge behavior.

## Adapter Implications

SCM adapters should expose:

- local capture primitive
- shared authority primitive
- optional review boundary primitive
- isolation primitive
- integration primitive
- release or promotion primitive where supported
- conflict representation mode
- whether authority is local, remote, or split by operation

Forge adapters should expose collaboration and review provider concepts
separately from SCM storage concepts.

## Current Nucleus Vocabulary Risks

The first `nucleus-scm-forge` skeleton still contains Git-heavy capability
names:

- `InspectBranches`
- `InspectCommits`
- `PrepareManagementCommit`
- `CreateManagementCommit`
- `PushManagementCommit`
- `OpenReviewBranch`
- `MergeWorkSession`

Those should become neutral where they describe core Nucleus behavior. Git
terms can remain in Git-specific descriptors, refs, forge refs, UI labels, and
provider-specific capabilities.

Risky but acceptable first-pass names:

- branch-like refs
- worktree-like refs
- pull request or merge request refs
- commit refs

These names are acceptable only when the type or field is explicitly
provider-specific, optional, or paired with provider-neutral change refs.

## Boundary Decision

Use these neutral capability terms for core SCM driver surfaces:

- inspect repository
- inspect working copy
- inspect isolation refs
- inspect captured changes
- detect dirty state
- prepare management capture
- create management capture
- share management capture
- open review boundary
- start primary working-copy session
- start isolated working-copy session
- integrate work session
- abandon work session
- classify conflicts
- propose mechanical conflict resolution

Git adapters may map those to commits, branches, pushes, worktrees, and pull
requests. Convergence adapters may map them to snaps, scopes, publications,
gates, bundles, promotions, and releases.
