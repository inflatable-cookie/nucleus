# 022 Command Runner Execution Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Move from command-runner vocabulary toward a real server-owned execution path
without bypassing policy, evidence, sandbox, or output-retention rules.

## Scope

- Promote a local command runner implementation contract.
- Define the first executable command subset.
- Keep execution server-owned and policy-gated.
- Define sanitized evidence behavior before running processes.
- Add a narrow runner boundary only after the implementation contract is clear.
- Keep desktop UI disposable and out of the authority path.

## Out Of Scope

- Provider harness process lifecycle.
- PTY terminal execution.
- Network-enabled commands.
- Secret access commands.
- Destructive commands.
- Full artifact payload storage.
- Remote transport.
- Desktop UI.

## Decisions

- The next server expansion is command runner readiness, not more desktop UI.
- The first runner subset should be local-only and read-only inspection unless
  the contract explicitly allows more.
- Process spawning is blocked until runtime strategy, sandbox posture,
  working-directory validation, output capture, timeout/cancellation, and
  evidence publication rules are promoted.
- Raw stdout/stderr must not become normal task history, logs, or UI state.
- The first local runner subset is structured-argv, read-only inspection only.
- Shell passthrough, writes, SCM mutation, worktree mutation, network access,
  secrets, destructive commands, PTY execution, and provider lifecycle remain
  blocked.
- Command request and evidence storage now has a metadata-only JSON codec in
  `nucleus-command-policy`.
- The first local read-only runner is a gate-only server skeleton. It emits
  queued or blocked sanitized evidence but does not spawn processes yet.
- `nucleusd command-runner smoke` exercises the gate-only path and prints
  sanitized evidence only.

## Execution Plan

- [x] Draft local command runner implementation contract.
- [x] Add command runner request/evidence storage readiness.
- [x] Add minimal local read-only command runner skeleton.
- [x] Add `nucleusd` command-runner smoke command if safe.
- [x] Reassess broader command execution readiness.

## Acceptance Criteria

- [x] First executable command subset is explicit.
- [x] Unsupported command scopes are explicitly blocked.
- [x] Sanitized evidence rules are implemented or blocked visibly.
- [x] No provider, SCM mutation, worktree mutation, network command, or secret
  access is introduced.

## Closeout

Broader command execution is not ready. The safe next server lane is command
evidence persistence and query integration, not host process spawning.

Remaining blockers are captured in
`docs/contracts/007-server-boundary-contract.md`.

## Cards

- `docs/roadmaps/g01/batch-cards/147-draft-local-command-runner-implementation-contract.md`
- `docs/roadmaps/g01/batch-cards/148-add-command-runner-storage-readiness.md`
- `docs/roadmaps/g01/batch-cards/149-add-minimal-local-read-only-command-runner-skeleton.md`
- `docs/roadmaps/g01/batch-cards/150-add-nucleusd-command-runner-smoke.md`
- `docs/roadmaps/g01/batch-cards/151-reassess-command-execution-readiness.md`
