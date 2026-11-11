# 049 — Evidence-based reconcile-and-continue recovery

Status: retired (2026-10-14)
Owner: Queue runtime and recovery maintainers
Created: 2026-10-12
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/specs/016-live-evidence-before-recovery.md`

## Purpose

An owning coordinator can request one evidence-based reconciliation of a
resolved operational fault and return the same task to its last proven
lifecycle state. There is no arbitrary reset, no new content work, and no
one-off owner control. Ordinary engine processing resumes once facts permit.
A known healthy wait is a successful disposition, not another recovery
escalation. Held or unknown results name the exact evidence or authority
still needed.

Tom (2026-10-12) approved one coherent coordinator reconcile-and-continue
capability under Queue reliability, building on the scoped external-check
fix rather than another parallel narrow patch.

## Shared classifier

`classifyReconcileContinue` reads only typed durable lifecycle evidence plus
bounded live thread/PR observation. Coordinator prose is never a field.
Caller identity must match this task, version and exact owning recovery
run/episode; unrelated or stale calls refuse.

Fail-closed first: pause, disposition, retired steps, open operator
decisions, incomplete inventory, uncertain merge/publication/delivery,
active writers, permissions, checkpoints, genuine blocked author/reviewer
results, and missing callbacks. Then, by shared invariants rather than
incident-reason whitelists:

| Class | Disposition | Next transition |
| --- | --- | --- |
| Known capacity or prerequisite wait | `healthy_pending` | `await_capacity` / `await_prerequisite` |
| Exact recorded fault objectively cleared | `recovered` | `clear_obsolete_incident` |
| Observed external merge awaiting sync/closeout | `recovered` | `ordinary_external_closeout` |
| Current-head accepted worker readiness | `recovered` | `accepted_readiness_review` or `accepted_readiness_pre_merge` |
| Late accepted reviewer result at the current head | `recovered` | `apply_accepted_review` |
| Settled callback with idle permission-free thread | `recovered` | `release_settled_lease` |
| Dispatch hold remaining | `healthy_pending` | `none` |

Missing callback, absent listing, elapsed timeout, vanished PID or
diagnostic prose never prove no effect. Unknown or reserved delivery,
active process or permission, ambiguous records, changed inputs or
incomplete remote inventory stay `held_unknown`. Genuine blocked results
and checkpoints stay `needs_owner`. Reconciliation may clear proven
obsolete fences; it cannot deliver reviewer continuation without a
separate explicit supported authorization. A retained live writer stays
pending. Known capacity waits do not allocate or raise caps.

## Coordinator and operator surfaces

The coordinator reports `northstar_report` `status: recovered` with
`recoveryAction: reconcile`. Queue binds that action to the exact recovery
run before release, then observes, reclassifies after each await, and
applies atomically. Retry, revise, resume_worker and reassign_origin remain
for those specific actions.

The operator uses `queue.task`:

```json
{
  "taskId": "<task id>",
  "version": 12,
  "action": "assess_recovery",
  "recoveryRunId": "<optional owning recovery run>"
}
```

```json
{
  "taskId": "<task id>",
  "version": 12,
  "action": "apply_recovery",
  "reason": "The recorded external-check fault has cleared; resume ordinary review.",
  "recoveryRunId": "<optional owning recovery run>"
}
```

`assess_recovery` is read-only aside from persisting the assessment.
`apply_recovery` requires a reason and uses the same classifier. A live
recovery coordinator still owns the episode unless a pending `reconcile`
action is bound. Both actions stay out of the external-effect operation
lane: they observe and mutate local durable state, then ordinary
callback, publication and closeout owners resume.

## Apply

Application rechecks task/version/phase, incident and recovery generation,
current run/workspace/branch/head/brief identity, receipts, pause,
disposition and live threads after every await and inside the commit.
Idle/permission-free proof for a lease release is two observations 250 ms
apart of the exact thread. Only already-settled proven-safe credentials are
revoked. Identity, evidence IDs, before/after phase and one
applied/refused disposition are retained durably. Lost response or restart
with the same identity does not duplicate the effect.

Recovered bookkeeping is separate from terminal result truth. Apply reuses
existing admission: accepted-PR workspace reconciliation, pre-merge
re-evaluation, ordinary exact-head review application, ordinary external
closeout, or lease release. `apply_accepted_review` keeps `reviewing` only
when the owning reviewer run is still `currentRunId`; a stored accepted
review with no owning run enters `verifying`. It does not manufacture a
verdict, open a content run, raise caps, unhold, continue a reviewer, launch
a fresh review, or revive retired stages.

## Exclusions

No consumer task control, workspace or branch edit, mass migration, live
database mutation, settings/pool/subscription/limit/pause change,
scheduler or frozen-010 change, release/workflow change or daemon restart.
No automatic review continuation, review inheritance, generic reset/unhold
or planning decision. No new task or prompt from this capability itself.
