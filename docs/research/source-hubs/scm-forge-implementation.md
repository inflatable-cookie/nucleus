# SCM Forge Implementation

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-16

## Purpose

Collect implementation evidence for SCM and forge adapters without assuming
Git is the only long-term SCM.

## Sources

- Gitoxide: `https://github.com/GitoxideLabs/gitoxide`
- git2-rs: `https://github.com/rust-lang/git2-rs`
- libgit2: `https://libgit2.org/`
- Jujutsu docs: `https://docs.jj-vcs.dev/latest/`
- Jujutsu source: `https://github.com/jj-vcs/jj`
- Pijul: `https://pijul.org/`
- Mercurial: `https://www.mercurial-scm.org/`
- Fossil: `https://fossil-scm.org/`
- Octocrab: `https://github.com/XAMPPRocky/octocrab`
- GitLab Rust crate: `https://crates.io/crates/gitlab/`
- Local Convergence specimen: `../convergence`

## First Findings

Git remains the first practical SCM target because most project repositories
and forges assume Git semantics.

Git implementation options:

- Gitoxide is a pure Rust Git implementation and should be researched for
  repository inspection and safe local operations.
- git2-rs wraps libgit2 and may be useful where libgit2 behavior or ecosystem
  maturity matters.
- Git CLI execution remains a fallback path but needs a command-runner policy,
  sandboxing policy, and output normalization before implementation.

Non-Git SCM findings:

- Jujutsu is a real modern SCM surface and can operate with Git-backed repos,
  but its user model is not identical to Git branch workflows.
- Pijul is patch-based. Nucleus must not force Pijul records into commit-only
  vocabulary.
- Mercurial is still a distributed SCM with its own revision and changeset
  model.
- Fossil combines distributed SCM with project-management surfaces such as bug
  tracking and wiki. It should be treated as SCM plus possible forge-like
  collaboration surface, not just a Git clone.
- Convergence separates local capture from shared authority. A `snap` is a
  workspace snapshot and is not necessarily buildable or authoritative.
  `publish` submits a snap to a scope/gate. Bundles, promotions, and releases
  are later consumable workflow points. Nucleus must model this as workflow
  semantics rather than forcing snaps into commit vocabulary.

Forge implementation options:

- Octocrab is the first GitHub API candidate for Rust research.
- The `gitlab` crate is a first GitLab API candidate for Rust research.
- Gitea, Bitbucket, and generic forge surfaces still need dedicated evidence.

## Adapter Rules

- SCM provider kind must be explicit.
- Git-specific commit and branch refs are allowed but must not be mandatory for
  every SCM.
- Provider-neutral change refs are required.
- Provider-neutral workflow semantics are required. Adapters must name local
  capture, shared authority, and review/publication boundary primitives.
- Provider refs must be retained as metadata.
- Forge issue ids must not replace Nucleus task ids.
- Webhook payloads and poll responses are inputs; normalized observations are
  server-owned state.
- Credential and webhook verification requirements must be specified before
  implementation.

## Research Gaps

- Gitoxide versus git2-rs suitability by operation class.
- Safe command-runner policy for Git, Jujutsu, Mercurial, Pijul, and Fossil.
- First-class forge provider order.
- Webhook signature verification model.
- Secret-reference model for forge and SCM credentials.
- Polling budgets and backoff policy.
- Convergence-style publication/gate fixtures for non-Git workflow tests.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `crates/nucleus-scm-forge`
