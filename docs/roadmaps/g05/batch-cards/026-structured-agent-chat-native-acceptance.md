# 026 Structured Agent Chat Native Acceptance

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../008-structured-agent-chat-acceptance.md`
Depends on: card 025
Auto-start next card: no

## Objective

Run the bounded authenticated question, plan-mode, task-list, and child-work
acceptance pass.

## Acceptance

- [x] explicit operator approval is recorded before provider effects
- [x] one typed question resumes the exact live turn
- [x] plan-mode effective evidence matches the selection
- [x] task-list status and priority appear
- [x] child attribution and cleanup remain honest

## Stop Conditions

- do not run without a separate operator gate
- stop on provider-version or capability mismatch and record it exactly

## Operator Gate

Blanket authorization for bounded authenticated Nucleus acceptance was granted
in-thread on 2026-07-31 before this card ran any provider effect.

## Native Runs

### Initial Run

Environment:

- Nucleus `8c95c9c9eae5d340cf2f5faf0a3c3d4743059d29` plus the active g05 worktree
- Swallowtail `39fd164069fc7325a8bbcbfd8cc616bc744c3c9c`
- Codex CLI `0.146.0`
- ChatGPT login
- isolated Nucleus state root and read-only fixture repository at commit
  `33691cfb65980009b6f473d28a3c1597133ee0ef`
- `gpt-5.4-mini`, low reasoning, Plan mode

Observed:

- Plan remained selected and immutable while the turn was active.
- Codex emitted the requested typed single-choice callback.
- Nucleus kept the rest of the UI live while the callback waited.
- Selecting `README.md` resolved the pending composer question and produced one
  durable answered-question transcript record.
- The resumed provider stream then failed with
  `swallowtail.codex.app_server.malformed_notification` before the provider
  task-list and child-work stages.
- Sanitized terminal evidence reported one failed turn, zero active turns, and
  no unexpected terminal class.

Compatibility diagnosis:

- Codex `0.146.0` declares `ServerRequestResolvedNotification.requestId` as a
  `RequestId`, and `RequestId` may be a string or integer.
- Swallowtail normalizes either form when the callback begins, but its current
  `serverRequest/resolved` activity projection requires `requestId` to be text.
- That contract mismatch matches the failure boundary immediately after the
  provider request was answered. The integer form is the protocol-defined form
  rejected by that projection. Raw provider payloads were not persisted or
  parsed by Nucleus.

Per this card's stop condition, no authenticated retry ran. The remaining
acceptance checks stay open until Swallowtail accepts both protocol-defined
request-id representations.

### Request-Reference Rerun

The Swallowtail representation-aware request-reference fix was available at
`1d7b8b3a4a3b124b1b36e650bd3b8dd6b425a1c7`. Nucleus rebuilt against that
local path dependency and reran the same bounded case from a fresh isolated
state root and read-only fixture repository at commit
`fef795253bf6dce8496760a9662ee4a2aa743645`.

The remaining environment was unchanged:

- Nucleus `8c95c9c9eae5d340cf2f5faf0a3c3d4743059d29` plus the active g05 worktree
- Codex CLI `0.146.0`
- ChatGPT login
- `gpt-5.4-mini`, low reasoning, Plan mode

Observed:

- Plan remained selected and immutable while the turn was active.
- The typed single-choice question rendered and accepted `README.md`.
- Its durable answered-question record appeared in the transcript.
- The exact live turn resumed past `serverRequest/resolved`, confirming the
  request-reference fix.
- Codex published plan commentary and completed one `spawnAgent`
  collaboration call.
- The first child-owned activity then failed with
  `Codex app-server event belongs to a different provider session`.
- The child was not admitted to the operation directory before failure, so
  child selection, attribution, terminal state, and cleanup remain unproven.
- No structured provider task-list acceptance was visible before failure.
- Sanitized terminal evidence reported one failed turn, zero active turns, and
  no unexpected terminal class.

Compatibility diagnosis:

- Swallowtail currently verifies every ordinary activity notification against
  the root provider thread ID.
- A real Codex child may emit activity whose envelope carries the child thread
  ID after `spawnAgent` establishes that child through collaboration evidence.
- The safe shared-adapter rule is to admit the root thread and exact child
  thread IDs already established for that operation, while continuing to
  reject arbitrary foreign thread IDs.
- Nucleus must not weaken session ownership or parse Codex-native events to
  work around this boundary.

Per the stop condition, no further authenticated retry ran at this point. Card
026 was paused for the Swallowtail child-thread activity admission fix and one
fresh rerun.

### Child-Activity Admission Rerun

Swallowtail commit `780a7d4fb3520ac75b58994b576c1236d0116298`
implemented bounded operation-local child activity admission. Nucleus rebuilt
against local Swallowtail HEAD
`b0c1dcea7a1cc688fe6fde8ce4da1547ff87a38a`, which contains that commit, and
reran the bounded case from a fresh isolated state root and read-only fixture
repository at commit `487dbe8bdc3370212c903c26c07d3fd9ced8805d`.

Observed:

- Plan remained selected and immutable while the turn was active.
- The typed question rendered, accepted `README.md`, produced one durable
  answer record, and resumed the exact turn.
- Provider-authored plan prose displayed all three requested statuses. No
  portable `TaskListSnapshot` was emitted, so structured task-list status and
  priority acceptance remains open.
- A completed primary-owned `spawnAgent` observation carried one exact child
  ID. Nucleus persisted that child in the operation-local directory as
  `pending`.
- Before any child-attributed activity was persisted, the runtime again failed
  with `Codex app-server event belongs to a different provider session`.
- The transcript child selector still exposed only `All work` at the failure
  boundary.
- Sanitized terminal evidence reported one failed turn, zero active turns, and
  no unexpected terminal class.

Refined compatibility diagnosis:

- The completed spawn proves that the child ID was available through portable
  collaboration evidence before failure.
- The new ordinary item-activity admission should accept that exact ID.
- The same failure therefore occurs on a remaining root-only notification
  path before ordinary child activity is emitted. A child turn-lifecycle
  notification is the leading inference, but Nucleus did not inspect or parse
  raw Codex payloads to assert the exact method.
- Swallowtail must classify real post-spawn child lifecycle notifications and
  handle known-child lifecycle as observation only. Such notifications must
  not set the root provider turn ID, finish the root operation, answer a
  callback, or gain child-control authority.
- Unknown, stale, cross-operation, and post-terminal child IDs must continue to
  fail closed.

Per the stop condition, no further authenticated retry ran at this point. Card
026 was paused for upstream classification and one fresh rerun.

### Child-Lifecycle Rerun

Swallowtail commit `c7d20b0000528774e5c384b72c922fec5725117e`
added operation-local child turn-lifecycle observation without granting child
control or root-turn authority. Nucleus rebuilt against that local path
dependency and reran the bounded case from a fresh isolated state root and
read-only fixture repository at commit
`384ba080fd69de3b212574d28c8ad1e94d1429c4`.

Observed:

- Plan remained selected and immutable while the turn was active.
- The typed question rendered, accepted `README.md`, persisted one durable
  answer record, and resumed the exact live turn.
- One completed root-owned `spawnAgent` observation admitted the exact child.
- Child start, reasoning, assistant output, command execution, and completion
  all retained that child attribution. None terminated or mutated the root.
- The operation-local directory ended with the child in `completed` state.
- The root turn completed successfully with zero failed, active, or unexpected
  terminal turns.
- After restart, the child selector exposed `All work`, `Main agent`, and the
  exact completed child. Selecting it filtered the transcript to that child's
  attributed activity.

Codex rejected `update_plan` in this Plan-mode turn. That is the provider's
declared behavior: harness Plan mode and the task-list tool are separate
capabilities. Task-list acceptance therefore ran as a separate Normal-mode
case rather than weakening or conflating either contract.

### Normal-Mode Task-List Run

Nucleus opened a separate Normal-mode session from a fresh isolated state root
and read-only fixture repository at commit
`6e47c9f66e0f6d1a7c4a1f2975bc6aabe138385a`.

Observed:

- Codex emitted four authoritative replacements for one three-item portable
  task-list snapshot.
- Status advanced from the first item in progress through each ordered step to
  all three items completed.
- Every item retained `priority: null`; Nucleus did not invent a priority.
- The completed snapshot persisted and replayed after restart.
- Nucleus now renders explicit `Completed`, `In progress`, and `Pending` text,
  because Poodle's current Markdown renderer presents checkbox syntax as
  ordinary bullets.
- Native accessibility and visual inspection exposed all three completed
  labels. The root turn completed with zero failed, active, or unexpected
  terminal turns.

No authenticated work remains for this card.
