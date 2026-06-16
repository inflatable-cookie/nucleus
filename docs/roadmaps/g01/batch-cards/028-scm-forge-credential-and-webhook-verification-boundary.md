# 028 SCM Forge Credential And Webhook Verification Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft SCM/forge credential and webhook verification boundary.

## Scope

- Define credential reference rules for SCM and forge adapters.
- Define webhook verification requirements before webhook ingestion exists.
- Separate secret material from projection state, observations, and task
  history.
- Define sanitized auth and verification evidence.
- Promote durable rules into SCM/forge and storage contracts.

## Out Of Scope

- Implementing credential storage.
- Implementing webhook endpoints.
- Implementing signature verification.
- Selecting a secret-store backend.
- Implementing provider API clients.

## Evidence Questions

- Which credential types need references first?
- How should webhook signing secrets be referenced?
- What verification metadata can be retained safely?
- Which auth failures should become repair work?
- How should local SCM command credentials be distinguished from forge API
  credentials?

## Stop Conditions

- Raw secrets are modeled as projection state.
- Webhook payloads are trusted without verification policy.
- Credential failure output can leak tokens.
- Forge API auth and local SCM auth are treated as the same boundary.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `crates/nucleus-scm-forge`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
