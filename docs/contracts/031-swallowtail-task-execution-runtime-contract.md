# 031 Swallowtail Task Execution Runtime Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-07-20

## Purpose

Replace Nucleus's remaining direct Codex task transport through Swallowtail
without moving task authority, workflow state, evidence, or product outcomes
out of Nucleus.

## Consumer Facade

Nucleus owns one provider-neutral `TaskExecutionRuntime` port. Goal and task
workflow code calls this port; it does not call Codex or Swallowtail directly.

The port accepts one Nucleus-owned execution request containing:

- task, work-item, mandate, project, and expected-revision context
- one server-resolved execution-host and working-resource target
- one exact configured provider route and model/reasoning selection
- Nucleus-authored task prompt and developer instructions
- one host-monotonic deadline
- one expanded task access policy

The port returns a Nucleus `TaskExecutionOutcome` and provider linkage. Its
Swallowtail implementation translates the request into portable runtime
records, drains events, classifies observations, awaits terminal state and
cleanup, then maps back. Swallowtail types do not enter Goal, task, review, or
desktop DTOs.

## Retained Nucleus Ownership

Nucleus remains authoritative for:

- conversation mandates, Goal snapshots, task ordering, readiness, and
  idempotency
- task/work-item lifecycle, waiting and recovery state, and operator actions
- execution-host and resource selection
- prompts, instructions, validation commands, and stop conditions
- provider-reference persistence and timeline linkage
- source/target checkpoints, diff summaries, review notes, and decisions
- runtime receipts, task receipts, Goal receipts, and UI projection
- retry, rework, cancellation admission, SCM publication, and task completion

Provider completion remains only a runtime fact. It cannot accept review,
complete a task, achieve a Goal, or publish changes.

## Exact Access Policy

The first Swallowtail-backed task run selects Contract 013's bounded workspace
profile with every dimension visible:

- working resource: server-approved project resource
- access: read/write
- writable boundary: that one resource only
- provider approval posture: never
- provider-side network: denied
- external search: disabled
- product tool declarations: none
- provider approval and user-input requests: correlated observe-and-stop only
- task turn deadline: 15 minutes unless later Nucleus policy selects a smaller
  explicit bound

This policy is independent from Agent Chat. Agent Chat stays read-only and may
carry declared Nucleus portal tools. A task run does not inherit chat tools,
chat transcript, resource fallback, or chat session identity.

## Host And Resource Authority

The server resolves the selected project resource and its authoritative
execution host before adapter work. The integration maps the resource id to an
opaque Swallowtail `WorkingResourceRef`; the host service alone holds its
locator and resolves a `ReadWrite` lease.

The embedded local adapter may execute only a resource whose authority belongs
to that embedded host. A remote-authoritative resource must fail before
process start until the same port is available on its server/worker host. The
desktop seeing a locator, or a local service carrying a remote host label, is
not authority.

Resource-free projects do not receive an implicit writable home-directory
fallback. Their tasks remain blocked until Nucleus admits an explicit writable
resource or later defines a temporary-workspace policy.

## Identity Mapping

The Nucleus execution/session attempt id is allocated before provider start.
It must not be derived from a provider thread id.

| Identity | Owner and use |
| --- | --- |
| task, Goal, mandate, work item, receipt | Nucleus durable domain ids |
| Nucleus execution/session attempt | Nucleus linkage allocated before open |
| Swallowtail request, session, turn, callback | integration-local runtime ids |
| configured instance, model route, execution host, resource ref | immutable preflight binding |
| provider session/thread, turn, approval, user-input | opaque external refs persisted only through Nucleus linkage |

The started linkage is persisted before the implementation waits for provider
completion. Partial linkage plus uncertain cleanup maps to recovery required,
not failure without refs.

## Provider Requests And Waiting Outcomes

Task execution declares no common product tools. If Codex emits an approval or
user-input request despite approval posture `never`, Swallowtail may expose
only the declared bounded provider-extension observation.

Nucleus maps the correlated observation to `WaitingForApproval` or
`WaitingForUserInput`, records its provider refs, then requires joined provider
cleanup. These are durable workflow states, not claims that the provider
process remains alive or resumable. Continuing work requires a separately
admitted retry, recovery, or future callback-response lane.

Unknown callbacks, malformed payloads, lost correlation, and undeclared
extensions map to failure or recovery required. Neither layer fabricates a
response or broadens authority.

## Outcome Mapping

| Swallowtail observation/outcome | Nucleus task outcome |
| --- | --- |
| completed with clean/not-applicable cleanup | `Completed` |
| observed approval request plus joined cleanup | `WaitingForApproval` |
| observed user-input request plus joined cleanup | `WaitingForUserInput` |
| consumer cancellation plus joined cleanup | `Cancelled` |
| provider/host/runtime failure with certain linkage and cleanup | `Failed` |
| timeout, disconnect, incomplete linkage, or degraded/failed/unknown cleanup | `RecoveryRequired` |

Timeout does not become ordinary failure because work may have changed the
resource before observation stopped. Provider completion with failed cleanup
also becomes recovery required.

## Deadline And Cleanup

- open and turn deadlines use the authoritative host monotonic clock
- operator cancellation and deadline expiry remain distinct
- every exit abandons callbacks, closes the turn and session, joins reader and
  process work, and releases only operation-owned leases
- the project resource has consumer cleanup authority and is never deleted
- drop is best-effort only and cannot supply a successful execution receipt
- raw stdout, stderr, provider frames, prompts, callback bodies, and local paths
  remain outside durable receipts and default diagnostics

## Diagnostic Smoke

The separately confirmed `nucleusd` read-only Codex smoke is not the
`TaskExecutionRuntime`. It uses a narrow Swallowtail-backed read-only diagnostic
runner in `nucleus-agent-adapters`; `nucleusd` retains the explicit CLI
confirmation gate and durable sanitized evidence. Swallowtail supplies provider
thread/turn refs, normalized event and provider-request counts, terminal status,
and explicit turn/session cleanup. The compatibility evidence projection names
semantic session milestones rather than retaining raw provider frames. The
smoke has no task tools, writable policy, task mutation, review, or execution
authority.

## Compatibility And Rollback

The first implementation stays behind the Nucleus-owned port. Existing Goal
run composition, `TaskExecutionOutcome`, linkage persistence, checkpoint/diff
capture, task-workflow receipts, and UI DTOs remain stable.

During migration one implementation is selected per build/test lane. The
direct and Swallowtail transports must not both execute one admitted work item.
Rollback selects the old port implementation before legacy removal; it does
not copy Swallowtail state into Nucleus domain records.

## Acceptance

- Goal/task workflow depends on `TaskExecutionRuntime`, not Codex wire code
- exact access policy is preflight-bound before process work
- one server-approved resource is the sole writable root
- Agent Chat remains read-only and unchanged
- provider and Nucleus identities remain distinct and recovery-safe
- all current task outcomes preserve their meaning
- checkpoints, diffs, review, receipts, and lifecycle remain Nucleus-owned
- remote-authoritative and resource-free writable execution fail closed
- authenticated task and two-task Goal runs retain review-ready evidence
