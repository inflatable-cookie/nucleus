# 063 — Proof execution through host runs

Status: fits:false
Scope: design only; no implementation or proof activation

## Boundary and evidence

Nucleus cannot currently enclose the requested proof's whole life within
**600 RAW, 512 MiB total (384 + 128), and all 445 unchanged oracles**. Durable
host-run ownership is useful, but does not establish the physical allocation
bound, hard blocked-I/O and reap deadline, or surviving direct-parent graph.
The findings below concern the existing routes, not the impossibility of a
future platform capability.

All Nucleus file:line citations are immutable links at this PR's source base,
`5f443890784e7c289647ccf1ab9e1ea7fb42228e`. The audited paths are unchanged from
the brief's planning base `ae72dc3a4edb7d93f0fcff2bf6a568e013445759`.
“Supported” credits only the stated property; “supported with limits” credits a
narrower existing property; “not supported” means the requested conjunction has
no qualifying evidence in these routes. No native observation is claimed.

The Effigy dependency evidence is the Nucleus-held lane document
`v015-qualification`, version 19, digest
`sha256:368de92769966ffbc992f286e28324f7207c25e7573f8738fb82d20a8dd874b1`,
section “Effigy #1017 — prepare and actor custody boundaries for Oxide #309”.
It was read for this design. It audits Effigy commit
`dc6f5abf5a5c5e37658b7048e9f8cc644df48709`; its source references below are
attributed to that report, not presented as a fresh Effigy source audit.
The report's result is `fits:false`, with no physical/time/custody qualification
credit. Neither that result nor this document grants execution authority.

[Spec 055](055-source-immutable-proof-executor.md) owns proof declaration and
source immutability; [Spec 058](058-responsible-tasks.md) owns responsible-task
routing; [Spec 035](035-host-run-scheduler.md) and
[Contract 010](../contracts/host-run-scheduling-010.md) own host runs. Contract
010's execution machinery remains present, but the recorded end state is
Nucleus admission with Effigy workload custody; this design does not reverse
that cutover decision ([docs/knowledge/specs/035-host-run-scheduler.md:2834–2838](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/docs/knowledge/specs/035-host-run-scheduler.md#L2834-L2838)).

## Source-bound verdicts

### Opt-in route — supported with limits

The declaration is explicit: selector, optional input hashes and author role
([shared/schema/review/proof.ts:11–18](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/shared/schema/review/proof.ts#L11-L18)). The executor intent binds selector,
inputs, tree, brief version/digest, authorization, run, task, generation, head
and selected agent ([core/dispatch/run-launch/run-intent.ts:17–72](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/dispatch/run-launch/run-intent.ts#L17-L72)).
Source checks require the exact published head, unchanged tracked source and
index; callback acceptance authenticates the run and rechecks the tree
([core/qa/proof-source.ts:21–59](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/qa/proof-source.ts#L21-L59);
[core/intake/callback-intake.ts:201–212](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/intake/callback-intake.ts#L201-L212)). For an automatic awaited proof,
the current rule requires the retained reviewer's source approval at that head
([docs/knowledge/specs/058-responsible-tasks.md:567–582](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/docs/knowledge/specs/058-responsible-tasks.md#L567-L582)).

This is **agent dispatch**, not a binding from that executor's selector to a
Nucleus-owned supervisor. `proofExecution` calls the ordinary `executor` launch
funnel ([core/dispatch/launch.ts:78–98](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/dispatch/launch.ts#L78-L98)), whereas host execution consumes a
separate stored submission with argv/cwd, scheduler run ID and epoch
([service/callbacks/host-run-endpoint.ts:526–578](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/callbacks/host-run-endpoint.ts#L526-L578)). There is no existing
proof-subject-to-host-run link in these paths. Genuine Effigy admission must
still occur on the actual selector: a new wrapper, a declared hash or a host
reservation cannot stand in for it. Contract 010's inherited token covers
nested admission only within an already admitted run; it supplies no new
physical or parent-handle guarantee
([docs/knowledge/contracts/host-run-scheduling-010.md:191–208](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/docs/knowledge/contracts/host-run-scheduling-010.md#L191-L208)).

### Time — not supported

The host scheduler records `launchedAt` at its launch boundary, then writes
the token environment and supervisor plan
([core/host-runs/host-run-launch.ts:31–58](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-launch.ts#L31-L58);
[service/callbacks/host-run-endpoint.ts:564–577](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/callbacks/host-run-endpoint.ts#L564-L577)). The supervisor reads the
plan/environment and opens state/output before calling the process owner
([service/executor/host-run-supervisor.ts:96–118](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/executor/host-run-supervisor.ts#L96-L118)). That owner's timer starts
on the command's `spawn` event
([core/machine/process-exec.ts:252–262](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L252-L262)). Submission, scheduler database and
journal writes, preparation and source copies are not enclosed by that timer.
Output closure, result publication and later evidence delivery also follow
execution ([service/executor/host-run-supervisor.ts:168–200](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/executor/host-run-supervisor.ts#L168-L200);
[core/intake/proof-files.ts:123–140](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/intake/proof-files.ts#L123-L140)).

Stop has identity waits, TERM grace and a post-KILL group wait; settlement can
continue waiting for leader exit, group emptiness and escaped absence
([core/machine/process-exec.ts:126–181](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L126-L181);
[core/machine/process-exec.ts:219–246](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L219-L246)). Synchronous retained-output fsync is
outside a surviving parent's enforced total deadline
([core/host-runs/host-run-retained-output.ts:74–85](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-retained-output.ts#L74-L85)). A launch timeout is
therefore not the original first-mandatory-effect-through-delivery **600 RAW**
bound. No conversion from RAW to `runTimeoutMs`, clock restart, grace extension
or assumed syscall completion is accepted. Lifetime ownership alone establishes
none of those timing guarantees.

### Storage — not supported

The budget and capacity sampler reserve CPU and memory; they do not enforce a
physical storage peak ([shared/schema/host-runs.ts:102–117](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/shared/schema/host-runs.ts#L102-L117);
[core/host-runs/host-run-capacity.ts:71–92](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-capacity.ts#L71-L92)). The actual owned ledger must
include all of the following, including failed and retained attempts:

| Charged allocation | Existing source and missing bound |
| --- | --- |
| Scheduler database, WAL/index, identity and journal | Host rows/identity and journal are separate durable writes ([core/store/store-host-runs.ts:14–30](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/store/store-host-runs.ts#L14-L30); [core/store/store-host-runs.ts:341–348](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/store/store-host-runs.ts#L341-L348)); store opening enables WAL ([core/store/store-admission.ts:252–256](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/store/store-admission.ts#L252-L256)). No all-owned per-proof physical ledger encloses them. |
| Submission, environment, plan, state, result and publication temporaries | Launch persists environment/plan ([service/callbacks/host-run-endpoint.ts:564–577](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/callbacks/host-run-endpoint.ts#L564-L577)); result and state are separate files ([service/executor/host-run-supervisor.ts:168–200](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/executor/host-run-supervisor.ts#L168-L200)). Atomic publication includes a temporary file and directory fsync ([core/host-runs/host-run-files.ts:571–594](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-files.ts#L571-L594)). All coexistence and partial-failure allocations count. |
| Output, in-memory copies and delivery duplicates | Each retained stream has an 8 MiB cap ([core/host-runs/host-run-endpoint-types.ts:50–56](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-endpoint-types.ts#L50-L56)), alongside the supervisor's in-memory retention ([service/executor/host-run-supervisor.ts:43–45](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/executor/host-run-supervisor.ts#L43-L45)). Proof delivery reads source bytes, creates evidence directories and writes another copy ([core/intake/proof-files.ts:100–140](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/intake/proof-files.ts#L100-L140)). Logical per-file limits do not bound total physical allocation. |
| Failure and retention | Output normally survives for an hour ([core/host-runs/host-run-endpoint-types.ts:23–24](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-endpoint-types.ts#L23-L24)); retention failures leave bytes and durable failure rows in place ([core/host-runs/host-run-retention.ts:63–68](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-retention.ts#L63-L68)). Retained bytes and later cleanup remain charged. |
| Metadata, allocation rounding, APFS COW, source copies and external providers | The audited writers above enforce owned paths, not an enclosing backing-allocation quota. Container closure is separately reported by a runtime ([docs/knowledge/contracts/host-run-scheduling-010.md:181–189](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/docs/knowledge/contracts/host-run-scheduling-010.md#L181-L189)). Neither file length, memory admission nor a removed-container report certifies these physical costs or provider-side copies. |

Both the 384 MiB part and the 128 MiB part belong inside 512 MiB; neither is a
free control-plane, log, failure or delivery allowance. The retained stream
intentionally omits bytes and redacts a token
([core/host-runs/host-run-retained-output.ts:35–65](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-retained-output.ts#L35-L65)). It is neither a complete
raw log nor an exemption allowing an uncharged second log. Keeping another raw
capture would charge both. Host-run lifetime ownership cannot establish this
physical peak; Effigy #1017 independently leaves APFS metadata/COW unbounded.

### Process custody — supported with limits

This is the existing direct-parent map, conditional on what is actually
launched. Application roles are not created by Nucleus merely because a run
names them.

| Child or role | Actual direct parent and handle | Retention limit |
| --- | --- | --- |
| Nucleus supervisor S | Service process creates a Node `ChildProcess`; the helper unrefs it and returns only its PID ([core/qa/supervisor-process.ts:46–55](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/qa/supervisor-process.ts#L46-L55)). The endpoint's wrapper returns no handle ([service/callbacks/host-run-endpoint.ts:137–143](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/callbacks/host-run-endpoint.ts#L137-L143)). | Detachment lets S survive a service roll. Durable PID/start identity and result reattachment are observations, not transfer of the service's child-wait relationship ([service/callbacks/host-run-endpoint.ts:600–606](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/callbacks/host-run-endpoint.ts#L600-L606)). |
| Submitted command X | S retains the local `child` from direct `spawn(executable, argv)` and observes its `exit`/`close` ([core/machine/process-exec.ts:74–82](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L74-L82); [core/machine/process-exec.ts:293–301](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L293-L301)). | This gives live S a direct command-child relationship. If X is Effigy, X is not the application actor. A shell that forks also adds an edge. S's death does not give a restarted service X's wait authority. |
| Actor A under Effigy E | Effigy #1017 reports E's direct wait relationship only when A is directly execed; a shell that forks A is instead its parent. | Nucleus's handle on E cannot wait on A. The report does not qualify survival of A's actual parent after E dies. |
| Actor-created custodian C | A, if A creates C; no Nucleus `ChildProcess` for C is supplied by the audited spawn path ([core/machine/process-exec.ts:74–87](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L74-L87)). | No handle-retention or transfer protocol through report failure, turn release or A's death. Effigy #1017 confirms the same limitation. |
| Monitor M and leaves L | C, if C creates them; otherwise their actual creators. Group/identity inventory records only observations ([core/machine/process-exec.ts:183–237](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L183-L237)). | No direct wait handles for these edges are supplied to S or Nucleus. An Effigy sentinel is not automatically this application monitor. |

Stop signals the whole command group with TERM and then KILL
([core/machine/process-exec.ts:139–175](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L139-L175)). S is outside that command group,
but C/M/L may be inside it: this does not protect the last application
custodian. No safe all-role stop plan is established by the existing default.

Failed report and turn release leave durable run/evidence records, not a
portable child-handle transfer. Losing the final actual parent leaves unknown
custody; neither reattachment nor capacity retention recreates it. The host
result type carries pgid/start identity and escaped descendants, with no
all-role parent/wait graph ([shared/schema/host-runs.ts:48–65](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/shared/schema/host-runs.ts#L48-L65)). These limits
also prevent a hard total reap deadline or physical 512 MiB claim.

### Positive reap — not supported for the required graph

The direct command's Node exit observation is useful live-parent evidence
([core/machine/process-exec.ts:295–301](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L295-L301)). It is not a durable, qualified
positive-wait receipt for every required direct child, including S, A, C, M, L
and any publisher. The actual surviving direct parent must positively wait on
and reap each required direct child; no identity or group observation transfers
that obligation. `processGroupEmpty` is a null-signal ESRCH check, and
`waitForProcessGroupEmpty` polls that check, not a child wait
([core/machine/process-group.ts:81–98](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-group.ts#L81-L98)). Even a certainly-empty group cannot
replace positive reap. Neither can capacity holds, escaped-process absence,
EOF or a terminal result. Spec 035 explicitly disclaims reaper authority for
its coverage retirement ([docs/knowledge/specs/035-host-run-scheduler.md:1742–1751](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/docs/knowledge/specs/035-host-run-scheduler.md#L1742-L1751)).

### Censuses and whole-backing absence — not supported

Three further obligations remain separate from the positive waits:

1. A **DECIDING** census must be qualified, completed, joined and bound to the
   exact custodian/attempt. Its join must complete, with the correct deciding
   evidence retained. An arbitrary group sample is not this census.
2. A **FINAL** group census must independently establish certain emptiness for
   the exact group at final closure. A deciding census or child wait cannot
   replace it.
3. **Whole-backing absence** requires separate provider evidence that the entire
   owned backing and its residual allocations are absent. Process emptiness,
   directory unlink and a container's `removed` flag do not establish it.

The host result/settlement schemas contain identities, exit and container
removal, but no deciding census, join, final census or backing-absence receipt
([shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/shared/schema/host-runs.ts#L48-L92)). The production completion path checks
group and escaped absence, then destroys pipes and settles
([core/machine/process-exec.ts:229–246](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L229-L246)); it does not establish these additional
obligations. This is narrower than saying Nucleus performs no group checks:
its ESRCH check is real, but has no qualified deciding-census/join provenance
([core/machine/process-group.ts:81–98](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-group.ts#L81-L98)).

### Capture completeness — not supported

The supervisor closes retained output before publishing its result
([service/executor/host-run-supervisor.ts:168–200](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/service/executor/host-run-supervisor.ts#L168-L200)), and the file writer
provides atomic publication with directory fsync
([core/host-runs/host-run-files.ts:571–594](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-files.ts#L571-L594)). Those are useful limits, not
complete capture: the group-settlement path destroys streams after a single
event-loop turn without requiring `pipesClosed`
([core/machine/process-exec.ts:219–246](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/machine/process-exec.ts#L219-L246)). Retention truncates and redacts;
flush/fsync errors are swallowed ([core/host-runs/host-run-retained-output.ts:74–85](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-retained-output.ts#L74-L85)).
Proof-file hashing and source revalidation bind some delivered evidence
([core/intake/proof-files.ts:123–140](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/intake/proof-files.ts#L123-L140);
[core/intake/callback-intake.ts:201–212](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/intake/callback-intake.ts#L201-L212)), but do not certify full EOF/drain,
successful fsync, in-window acknowledgement and the publisher's positive reap.
All are required together, within the original clock and charged storage.

### Failure accounting — supported with limits

Single-flight refuses an unreleased executor or an already reserved head, and
a proof-only attempt is never repeated/refunded/reset
([core/qa/proof-admission.ts:28–45](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/qa/proof-admission.ts#L28-L45)). Unknown or failed settlement preserves
the record and spent-head reason ([core/intake/proof-settlement.ts:45–62](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/intake/proof-settlement.ts#L45-L62)).
A missing report can be requested again without rerunning the selector
([core/qa/proof-admission.ts:65–77](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/qa/proof-admission.ts#L65-L77)). Host launch failure after the durable
launch boundary records reconciliation required rather than inventing a
stopped result ([core/host-runs/host-run-launch.ts:77–87](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/core/host-runs/host-run-launch.ts#L77-L87)).

These rules support conservative evidence handling. They are not an
implemented Oxide FAILED/SPENT lifecycle or a complete physical retention
ledger. The proof result schema accepts only reported passed/failed, selector,
exit and bounded text ([shared/schema/review/proof.ts:27–33](https://github.com/inflatable-cookie/nucleus/blob/5f443890784e7c289647ccf1ab9e1ea7fb42228e/shared/schema/review/proof.ts#L27-L33)); it does not
validate the missing custody/census/capture obligations. Missing evidence must
remain FAILED, SPENT or unknown for this envelope. No absence of a report,
start witness or process sample authorizes retry, reset or refund.

## Finite control plan: refusal oracle only

This is a pure evaluation plan for reviewing a later design, not a new runtime,
API or proposed implementation. Given one finite attempt record and qualified
provider observations, it returns all unmet obligations in the fixed order
below. Every input is `proved`, `disproved` or `unknown`; missing, unreadable,
wrong-identity and timed-out evidence is never `proved`. No evaluation performs
I/O, launches, stops, deletes, retries or changes capacity.

The record must bind the approved head/tree, exact selector and ordered inputs,
brief authority, task/executor/participant, scheduler run/epoch, actual Effigy
admission, exact argv/cwd/effective environment, required parent-child roster,
custodian and group identities, backing identity, and original clock origin.
A roster must itself have qualified completeness evidence; a declared list
cannot prove that no children or providers escaped it. The first mandatory
effect includes scheduler persistence, resolution/preparation and source copies.

| Order | Independently required predicate; refusal on anything unproved |
| --- | --- |
| 1 — Identity and admission | Explicit opt-in and exact approved subject remain source-immutable; actual selector has genuine Effigy admission. Refuse substituted participant, head, input, executable, environment, epoch or receipt. No synthetic admission, skipped hook or token exemption. |
| 2 — Clock | One qualified 600 RAW interval encloses first mandatory effect, preparation, capture, copies, stops, waits, finalization and acknowledged delivery. Refuse launch-origin clocks, unqualified RAW conversion, extra grace or unsupported blocked-I/O/wait bounds. |
| 3 — Storage and retention | Enforced all-owned physical peak is within 512 MiB, including both 384 + 128 parts, every ledger row above, failure/retention and every provider copy. Refuse logical-size-only evidence, uncharged second logs, metadata/COW exemptions or moving work outside the backing without charging it. |
| 4 — Custody | Qualified actual parent handles survive stop, report failure and turn release until their obligations complete. Refuse final owner loss without a qualified actual successor parent/wait relationship, or default group signalling that can destroy the last custodian. Observations transfer no handle. |
| 5 — Positive reaps | Each required direct parent has positively waited on and reaped each exact required direct child, including the publisher and supervisor. **Refuse even a certainly-empty group when any positive wait is absent.** |
| 6 — DECIDING census and join | A qualified, completed, custodian-bound DECIDING census exists and its join positively completed. **Refuse even with all positive waits when the join was lost/timed out or the deciding census is missing, wrong or unqualified.** |
| 7 — FINAL census | A separate certain-empty FINAL census covers the exact group after closure. **Refuse even with positive waits and a valid deciding census/join when FINAL is missing, unknown or non-empty.** |
| 8 — Capture and delivery | Full raw EOF, drain, successful fsync, exact source binding, in-window acknowledgement and publisher reap are all proved. Refuse truncation, swallowed write/sync faults, a mere delivery attempt or unacknowledged callback. Publisher reap is still required under order 5. |
| 9 — Whole backing | Provider proves whole-backing absence separately from all process waits and both censuses. Retained evidence and copies on any other backing remain charged; refuse unlink-only, empty-directory or group evidence as backing proof. |

Before any mandatory effect, an unqualified prerequisite returns `REFUSE`.
Once any mandatory effect occurred, a failed predicate returns
`FAILED/SPENT/retained`; an unresolved predicate returns `unknown/SPENT/retained`.
This is the required disposition, not a new spelling of existing schema states.
No result permits automatic retry, reset, refund or a new clock. Only a record
with **every** independent obligation proved could qualify as a fit; the
existing source cannot supply such a record. A failed execution never becomes
passing proof merely because its cleanup later completes.

## Effigy and platform dependencies

Effigy #1017 credits maintenance prepare as separate from later genuine
selector admission, **supported with limits**. It does not supply a TaskRun or
MemoryGuard enclosing prepare's first effect. Its cited
`src/runner/run_control.rs:95–147,206–263` and
`src/runner/task_engine/run/foreground.rs:181–225` explain that split. Wrapping
only the later invocation under a host run leaves earlier mandatory effects
outside the envelope; fabricating a maintenance selector would change that
split rather than satisfy it.

The report's other verdicts remain unsupported dependencies, not assumed APIs:

- **Physical enclosure:** Effigy Contract 049:496–522 leaves APFS metadata/COW
  unbounded; `crates/effigy-kernel/src/store.rs:30–58,500–506` describes a
  nominal 1 GiB logical database maximum, WAL limits after checkpoint and
  non-strict preparation. Nucleus's additional database/output/copies must
  also be charged; Nucleus ownership does not repair that bound.
- **Independent surviving prepare parent and hard total time:** Contract
  049:763–765 excludes blocked I/O/scheduling from the reserve; prepare's
  cooperative contexts do not supply a surviving direct parent. A host timer
  cannot turn those exclusions into a 600 RAW guarantee.
- **Actor/custodian/monitor/leaf handles:** the report cites
  `crates/effigy-kernel/src/custody/spawn.rs:400–414,741–787` for a live Effigy
  owner's direct leader wait and `supervise/memory.rs:226–251` for its separate
  sentinel child. The sentinel receives receipts, not the owner's child-wait
  authority. Actor-created descendants remain their actual parents' children.
  Positive reap, the deciding census/join, final census and whole-backing
  absence must each be supplied; no stronger conjunction is credited.

No qualified platform/storage provider is identified for an aggregate physical
allocation bound covering APFS COW/metadata and all external delivery/retention,
or for hard blocked-syscall completion and positive waits within the original
RAW interval. Neither macOS identity checks nor Linux process-group/pid
observations supply these guarantees. A VM, volume, container or extra parent
would itself add charged storage, lifetime and reap obligations; none is
provisioned or silently treated as a provider here.

## Disposition

**fits:false.** The blocking requirements are the first-effect 600 RAW bound
(including blocked I/O, positive reap and delivery), an enforced all-owned
512 MiB physical peak, the surviving actual parent/wait graph, qualified
DECIDING census/join and separate FINAL census, whole-backing absence, and
complete acknowledged capture with publisher reap. Their evidence and limits
are the corresponding source-bound verdicts above; durable host-run lifetime
ownership alone resolves none of the physical or hard total-time blockers.

No integration proposal, future API or implementation tranche is selected.
Reconsideration requires separately scoped design evidence for every unsupported
Effigy/platform dependency and every control-plan predicate, while retaining
600 RAW / 512 MiB / 445 unchanged. Implementation and proof activation require
separate briefs after that evidence and independent review. This document
ends with the single outcome **fits:false**.
