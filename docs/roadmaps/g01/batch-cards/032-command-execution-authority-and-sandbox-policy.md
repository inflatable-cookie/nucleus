# 032 Command Execution Authority And Sandbox Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft command execution authority and sandbox policy.

## Scope

- Define when Nucleus may run local commands on behalf of SCM, harness,
  validation, and steward workflows.
- Separate read-only inspection, management-state writes, source-code writes,
  network commands, and destructive commands.
- Define approval gates for command categories.
- Define sanitized command evidence.
- Promote durable rules into server, SCM/forge, task, and storage contracts.

## Out Of Scope

- Implementing a command runner.
- Selecting a process sandbox crate.
- Implementing PTY handling.
- Implementing provider adapters.
- Implementing UI approval prompts.

## Evidence Questions

- Which command categories are safe for automatic execution?
- Which commands require human approval every time?
- How should command stdout/stderr be summarized without leaking secrets?
- How should per-project command policy override server defaults?
- How should adapters request command authority without owning it?

## Stop Conditions

- SCM adapters can run shell commands directly without server policy.
- Command output is copied into task history or projection records by default.
- Destructive commands can run without explicit approval.
- Network-capable commands are treated the same as local read-only inspection.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- future Rust command-boundary crate or module

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
