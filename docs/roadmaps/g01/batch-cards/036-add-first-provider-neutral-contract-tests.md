# 036 Add First Provider-Neutral Contract Tests

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add first provider-neutral contract tests.

## Scope

- Add tests that use `nucleus-contract-fixtures` as the test-support boundary.
- Prove Git-like and Convergence-like workflow semantics without running SCM
  commands.
- Prove command-policy request and sanitized-evidence vocabulary without
  command execution.
- Keep tests provider-neutral and offline.
- Keep fixture helpers out of production crates.

## Out Of Scope

- Fake adapter implementation.
- Live Git, Convergence, forge, or harness commands.
- Network calls.
- Credential lookup.
- Server command execution.
- CI workflow changes.

## Evidence Questions

- Which fixture profiles need public constructors versus private test setup?
- Should first tests live inside `nucleus-contract-fixtures` or as workspace
  integration tests?
- Which assertions best prove the contract boundary without over-specifying
  implementation details?

## Stop Conditions

- Tests require live providers, host credentials, network, or shell.
- Production crates depend on `nucleus-contract-fixtures`.
- Fixture APIs start looking like stable production APIs.
- Tests assume Git terms apply to every SCM provider.

## Promotion Targets

- `crates/nucleus-contract-fixtures`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- First contract tests live inside `nucleus-contract-fixtures` as crate-level
  integration tests.
- Fixture constructors are public within the unpublished dev-only crate so
  tests can share provider-neutral values.
- Tests assert workflow semantics, command policy, sanitized evidence,
  task-link identity separation, credential/webhook evidence, conflict
  classification, and abandoned review audit state.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
