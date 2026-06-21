# Convergence SCM Shape

Status: active
Owner: Tom
Updated: 2026-06-21

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
- `../convergence/src/cli_commands/commands.rs`
- `../convergence/src/cli_exec/delivery/publish_sync/publish.rs`
- `../convergence/src/remote/transfer/publish/mod.rs`
- `../convergence/src/remote/types/publication_flow.rs`
- `../convergence/src/bin/converge_server/routes/repo_core.rs`
- `../convergence/src/bin/converge_server/routes/release_promotion.rs`
- `../convergence/src/bin/converge_server/handlers_publications/publications/create.rs`
- `../convergence/src/bin/converge_server/handlers_publications/publications/validate.rs`
- `../convergence/src/bin/converge_server/handlers_release/promotion_endpoints/create.rs`
- `../convergence/src/bin/converge_server/access.rs`

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

## Backend Surface Refresh 2026-06-21

Observed command surfaces:

- `converge snap` creates a local `SnapRecord` from the workspace manifest and
  stores it locally as the head snap.
- `converge publish` selects a snap, scope, and gate, then uses the remote
  client to upload missing objects and create a publication.
- `converge sync` updates unpublished lane heads and is separate from
  publication.
- `converge bundle`, `promote`, `release`, `approve`, `pins`, and `resolve`
  are separate collaboration and authority steps.

Observed remote/server surfaces:

- repo routes expose lanes, lane heads, gate graph, scopes, publications,
  bundles, pins, approvals, releases, promotions, and promotion state.
- publication creation checks publisher permission, known scope, known gate,
  duplicate snap/scope/gate publication, metadata-only gate policy, and snap
  object availability.
- promotion checks publisher permission, bundle promotability, gate
  relationship, superposition policy, approval count, and downstream gate
  validity.
- release and promotion are distinct from publication; publication is intake,
  promotion moves bundle authority, and release creates a consumption pointer.

Nucleus runner implications:

- A Convergence runner cannot be modeled as `commit then push then PR`.
- Local capture, object upload, publication creation, lane-head sync, bundle
  creation, approval, promotion, release, and resolution publication are
  separate effect authorities.
- Metadata-only publication is an explicit mode gated by server policy.
- Remote identity/token readiness and publisher permission are mandatory
  preflight inputs before any real publish, promotion, approval, or release
  effect.
- Runner records must preserve snap id, root manifest, scope, gate, lane,
  publication id, bundle id, promotion id, release channel, publisher/user id,
  metadata-only mode, and resolution refs where applicable.
- Convergence conflict handling uses superpositions and resolution records;
  Nucleus must not collapse these into Git conflict or merge terminology.
