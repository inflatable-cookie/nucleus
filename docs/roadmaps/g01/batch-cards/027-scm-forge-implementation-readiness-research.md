# 027 SCM Forge Implementation Readiness Research

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft SCM/forge implementation readiness research.

## Scope

- Research Rust Git libraries and command-runner options.
- Research GitHub, GitLab, Gitea, Bitbucket, and generic forge API options.
- Research webhook verification and polling boundaries.
- Identify credential and secret-reference requirements.
- Promote implementation constraints into SCM/forge contracts.

## Out Of Scope

- Implementing Git operations.
- Implementing forge API clients.
- Choosing a final provider list.
- Implementing credentials.
- Implementing webhook servers.

## Evidence Questions

- Which Git operations should use a Rust library versus shelling out to `git`?
- Which forge providers need first-class adapters first?
- Which provider refs are stable enough for durable task links?
- How should webhook signatures and secret references be represented?
- Which polling surfaces are safe for low-frequency refresh?

## Stop Conditions

- Provider auth secrets are copied into docs or projection state.
- A forge SDK is selected without evidence.
- Git CLI execution is treated as already safe.
- Webhook verification is deferred without a contract gap.

## Promotion Targets

- `docs/research/source-hubs/`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `crates/nucleus-scm-forge`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
