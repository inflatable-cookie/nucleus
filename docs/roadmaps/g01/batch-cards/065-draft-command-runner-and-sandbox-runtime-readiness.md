# 065 Draft Command Runner And Sandbox Runtime Readiness

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft command runner and sandbox runtime readiness.

## Scope

- Define what must be true before command execution implementation can begin.
- Name runtime surfaces for process spawning, sandbox selection, environment
  construction, credential injection, output capture, cancellation, timeout,
  artifact retention, and sanitized evidence publication.
- Keep readiness separate from implementation.
- Batch with compile-only readiness vocabulary if stable enough.

## Out Of Scope

- Command execution implementation.
- Sandbox implementation.
- PTY implementation.
- Credential injection implementation.
- Artifact store implementation.
- Runtime scheduling.

## Evidence Questions

- Which sandbox profiles can be named before host-specific implementation?
- Which command scopes require credential readiness?
- Which output capture paths are safe by default?
- Which cancellation and timeout states need runtime readiness gates?

## Stop Conditions

- The draft spawns commands.
- The draft chooses a sandbox backend.
- The draft stores raw command output by default.
- The draft lets credential access bypass command approval.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`
- `crates/nucleus-server`
- `crates/nucleus-command-policy`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
