# 2026-07-20 Swallowtail Task Executor Adoption

## Decision

Nucleus product Goal/task execution now uses a Nucleus-owned
`TaskExecutionRuntime` port backed by Swallowtail's bounded Codex app-server
session. The direct JSON-RPC runner in `local_codex_chat/task_execution.rs` is
removed.

## Preserved Authority

Nucleus still owns admission, task prompts and instructions, model route,
deadline, session-attempt identity, started-linkage persistence, Goal ordering,
mandates, checkpoints, diffs, review state, receipts, and product outcomes.
Swallowtail owns provider process, protocol, bounded workspace mapping,
provider-request observation, interruption, terminal delivery, and cleanup.

Agent Chat remains on its independent read-only profile with the existing
Nucleus tool portals.

## Outcome Mapping

- clean completion remains completed and reviewable
- approval and user-input observations remain distinct waiting outcomes
- cancellation remains stopped
- provider, host, and runtime failures remain failed when cleanup is certain
- timeout, stream failure, linkage-persistence failure, and uncertain cleanup
  require recovery

## Evidence

- the registry resolves chat and task runtimes independently by adapter id
- the task plan binds one read/write filesystem resource, denied network,
  disabled search, approval `never`, no product tools, and both declared
  provider-request extensions
- the existing running transition is persisted before terminal observation
- 2,001 focused protocol, adapter, and server tests pass

## Next

Assess the separately gated daemon Codex smoke. Route it through Swallowtail's
read-only runtime or retire it if shared runtime evidence fully supersedes it.
