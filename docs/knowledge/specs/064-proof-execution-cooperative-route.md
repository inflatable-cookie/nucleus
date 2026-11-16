# 064 — Proof execution under cooperative qualification

Status: conditional proposal
Scope: one future route proposal; no implementation or proof activation

## Authority and changed premises

Tom adopted Oxide's cooperative qualification contract for future oxide#309
work on 2026-11-16 and authorized one independently reviewed Nucleus route
proposal only (Tom, 2026-11-16, board decision
`ea8ee47f-adc0-4cd3-b420-aaa30642d623` v2). The original assessment below
rejected the unchanged route; the conditional proposal completes that same
authorized deliverable. The pinned document still calls itself proposed; adoption
comes from that operator ruling, not from its prose. The complete contract was
read at merge `f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed` (PR 270, reviewed
head `f825c046fcee06b320ec8b4e162f87b1ed339573`); its bytes match
`sha256:2bbb15f2f064b8048c7937481110a740d4a0202c4f6a016a24e1bef9470a002b`.
See [cooperative-qualification.md:1–10](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L1-L10).

This changes the resource question: 600 seconds is one cumulative target from
the first mandatory effect, not a hard bound on blocked I/O, scheduling,
fsync, waits/reaps or delivery. The 512 MiB scratch target is monitored, not
an enforced all-physical peak; 384 + 128 is planning within it. All 445 cases
and the independent safety/closure predicates remain required. See
[cooperative-qualification.md:14–104](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L14-L104). Spec 063 and Effigy #1017's original `fits:false` conclusions
remain unchanged; their old physical/time guarantees are not demanded again
by this assessment ([docs/knowledge/specs/063-proof-execution-host-runs.md:290–305](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L290-L305)).

The preserved audit's Nucleus citations name its original base commit,
`bc27bf69ea9beccddfb91785653fa2a72bb3e2fe`; the proposal's seam map names this
PR's base, `5ae03a1d1b6c40460567aa55380869b378be9dd6`. Contract citations name
the pinned Oxide merge above. Effigy dependencies are attributed to the complete
Nucleus-held `v015-qualification` v19 report, read for this assessment, digest
`sha256:368de92769966ffbc992f286e28324f7207c25e7573f8738fb82d20a8dd874b1`,
auditing Effigy `dc6f5abf5a5c5e37658b7048e9f8cc644df48709`. The base already
records that provenance and its limits
([docs/knowledge/specs/063-proof-execution-host-runs.md:20–29](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L20-L29)). This is source
inspection, a conditional design and a written refusal plan; it supplies no
native measurements, qualification credit, new provider or execution authority.

## One assessed route and its exact surface

The smallest route assessed is to bind the existing proof executor's subject
to one existing host-run submission, retain that run's output and settlement,
then accept its evidence through the existing authenticated proof callback.
**The unchanged candidate is rejected below.** This audit establishes the
existing seams and gaps; the later proposal selects bounded future changes
at those seams, without authorizing implementation:

| Exact files / APIs / records | Existing support and missing connection |
| --- | --- |
| `shared/schema/review/proof.ts`: `proofExecutionRequestSchema`, `proofExecutionRecordSchema`; `core/dispatch/run-launch/run-intent.ts`: `runIntent` | Selector/inputs/author role and source/authority/run/participant bindings exist. The intent carries tree and brief identity. Neither schema/intent supplies the required all-role wait/census/capture evidence. [shared/schema/review/proof.ts:11–64](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/review/proof.ts#L11-L64), [core/dispatch/run-launch/run-intent.ts:17–82](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/dispatch/run-launch/run-intent.ts#L17-L82). |
| `core/qa/proof-source.ts`: `verifyProofSource`; `core/dispatch/launch.ts`: `proofExecution` | Exact published head, tracked source and index are checked, but dispatch launches an agent as `executor`, not a bound host-run command. [core/qa/proof-source.ts:21–59](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/proof-source.ts#L21-L59), [core/dispatch/launch.ts:78–98](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/dispatch/launch.ts#L78-L98). |
| `service/callbacks/host-run-endpoint.ts`: `onSubmit`, `schedulerInput`, `launch`, `cancelRun` | Separate submit/attach/status/report/cancel transport; stored caller/request/argv/cwd/env-key identity, scheduler run/epoch, supervisor plan and cancel request. No proof-subject binding is established by this transport. Effective environment values are ephemeral, not a complete retained execution identity. [service/callbacks/host-run-endpoint.ts:438–491](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L438-L491), [service/callbacks/host-run-endpoint.ts:526–578](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L526-L578), [service/callbacks/host-run-endpoint.ts:652–677](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L652-L677). |
| `service/executor/host-run-supervisor.ts`: `runHostRunSupervisorMain`; `core/machine/process-exec.ts`: `executeHookProgram` | Supervisor directly spawns one executable with literal argv, observes its exit and streams chunks to retained output. It does not construct the application's parent graph. [service/executor/host-run-supervisor.ts:96–174](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/executor/host-run-supervisor.ts#L96-L174), [core/machine/process-exec.ts:74–87](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L74-L87). |
| `core/host-runs/host-run-files.ts`: `hostRunSupervisorPaths`; `shared/schema/host-runs.ts`: result/settlement | Existing submission, plan, live state, cancel, disconnect, stdout/stderr, result and retention files; result/settlement record command identity, exit, escaped descendants and container removal. They have no qualified census/join, all-child positive-wait or whole-backing receipt. [core/host-runs/host-run-files.ts:263–278](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-files.ts#L263-L278), [shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92). |
| `core/host-runs/host-run-retained-output.ts`; `core/host-runs/host-run-retention.ts`; `core/intake/proof-files.ts`; `core/intake/callback-intake.ts`; `core/intake/proof-settlement.ts` | Existing output, retention failures, evidence copies/hashes, callback source recheck and spent-head settlement are useful separate mechanisms. They do not constitute complete raw delivery qualification. [core/host-runs/host-run-retained-output.ts:35–85](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-retained-output.ts#L35-L85), [core/host-runs/host-run-retention.ts:63–94](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-retention.ts#L63-L94), [core/intake/proof-files.ts:100–142](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-files.ts#L100-L142), [core/intake/callback-intake.ts:201–212](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/callback-intake.ts#L201-L212), [core/intake/proof-settlement.ts:45–62](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-settlement.ts#L45-L62). |

There is also a routing boundary: Spec 035's approved end state is Nucleus
admission with Effigy workload custody. The presence of Contract 010 supervisor
code does not authorize reversing that cutover or treating a host token as
actual selector admission. [docs/knowledge/specs/035-host-run-scheduler.md:2834–2838](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/035-host-run-scheduler.md#L2834-L2838),
[docs/knowledge/contracts/host-run-scheduling-010.md:191–208](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/contracts/host-run-scheduling-010.md#L191-L208).
The unchanged-route audit selected no new file, API or record. The conditional
proposal below now names the future changes; none is implemented here.

## Actual parents through prepare, stop and loss

The required graph must be established before effects, with every actual
parent retaining its own required child relationship. Positive wait/reap,
DECIDING/join, FINAL and backing absence are separate obligations; identities,
capacity and EOF transfer no wait authority. [cooperative-qualification.md:73–94](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L73-L94).

| Stage / edge | Existing relationship and limit |
| --- | --- |
| Prepare | Effigy #1017 places maintenance prepare in its invoker, separate from later selector admission. A supervisor wrapping only the later selector cannot cover earlier prepare. The reported prepare route has no independently surviving prepare parent. [docs/knowledge/specs/063-proof-execution-host-runs.md:252–261](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L252-L261), [docs/knowledge/specs/063-proof-execution-host-runs.md:270–273](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L270-L273). |
| Service → supervisor S | `spawnDetachedSupervisor` creates a Node child, unrefs it and returns only PID; endpoint wrapper returns no retained wait handle. Detachment can survive a service roll; it does not retain an evidenced service→S positive wait/reap across service loss. [core/qa/supervisor-process.ts:46–55](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/supervisor-process.ts#L46-L55), [service/callbacks/host-run-endpoint.ts:137–143](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L137-L143). |
| S → command X | S retains the local child and its exit/close handlers. If X is Effigy E, S's child is E, not the actor A. A shell that forks adds a parent edge. This credits live direct-command observation only. [core/machine/process-exec.ts:74–82](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L74-L82), [core/machine/process-exec.ts:293–301](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L293-L301). |
| E → A → custodian C → monitor M / leaves L | Effigy #1017 credits E's positive leader wait only for a directly execed A. C/M/L remain their actual creators' children; the separate Effigy sentinel is not their parent or an inherited wait handle. No surviving all-role graph is supplied. [docs/knowledge/specs/063-proof-execution-host-runs.md:274–280](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L274-L280). |
| Publisher P | The host supervisor writes its result in-process; proof files are copied in callback processing. Neither path supplies a separately qualified publisher process and its creator's positive wait/reap. If a later delivery route creates P, its actual parent edge must be added and proved; a file publication is not P's reap. [service/executor/host-run-supervisor.ts:168–200](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/executor/host-run-supervisor.ts#L168-L200), [core/intake/proof-files.ts:128–142](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-files.ts#L128-L142), [cooperative-qualification.md:73–82](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L73-L82). |
| Stop | Endpoint persists cancellation to the supervisor. Process execution TERM/KILL targets the command group and discovered escapees. C/M/L could occupy that group, so it does not qualify the required prohibition on KILL of the last custodian. Do not invoke this default as a safe qualification stop. [service/callbacks/host-run-endpoint.ts:652–675](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L652-L675), [core/machine/process-exec.ts:139–175](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L139-L175), [cooperative-qualification.md:79–82](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L79-L82). |
| Report failure / turn release | Durable submission, result and spent proof evidence can remain; no portable child-handle transfer is present in those records. Existing single-flight permits requesting a missing executor report, not rerunning its selector. [shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92), [core/qa/proof-admission.ts:28–45](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/proof-admission.ts#L28-L45), [core/qa/proof-admission.ts:65–77](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/proof-admission.ts#L65-L77). Required surviving parents still owe every unfinished wait after report or turn release. [cooperative-qualification.md:23–30](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L23-L30). |
| Service / E / A / C owner loss | Endpoint recovery reattaches observations of submissions/results, not actual parenthood. The reported Effigy sentinel lacks E's child-wait authority. Losing an unsupported actual parent leaves custody unknown, FAILED/SPENT/retained; there is no guaranteed closure, successor or new cleanup authority. [service/callbacks/host-run-endpoint.ts:600–606](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L600-L606), [docs/knowledge/specs/063-proof-execution-host-runs.md:274–280](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L274-L280), [cooperative-qualification.md:23–30](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L23-L30). |

An ESRCH group check is useful absence evidence but not positive child wait;
the poll named `waitForProcessGroupEmpty` polls that check. It supplies neither
a qualified completed/joined custodian-bound DECIDING census nor a separate
qualified FINAL census. Result and settlement schemas also lack those receipts.
[core/machine/process-group.ts:81–98](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-group.ts#L81-L98), [shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92).
Even all positive waits would not discharge either census or provider backing
absence; removed-container flags do not prove residual allocations absent.
[cooperative-qualification.md:84–94](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L84-L94).

## Cumulative time and monitored storage

Required time origin **t0** is immediately before the first mandatory effect,
including scheduler persistence or any earlier prepare/capture/copy. The one
elapsed interval must include admission, work, stop requests, waits,
finalization and acknowledged delivery. Plan all cutoffs against t0: candidate
at t0+560 s, suite at t0+530 s, stop allocation 20 s and exit allocation 2 s
inside the same remaining target. They overlap enclosing budgets and cannot
be added to 600 or restarted at each stage. Earlier elapsed work reduces
remaining time; no RAW/cross-clock conversion is assumed. [cooperative-qualification.md:14–30](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L14-L30).

Current `launchedAt` begins at the launch transaction, after submission/env
persistence; the command timeout begins at spawn; supervisor `wallMs` runs
from plan launch time. None is the required first-effect cumulative clock or
covers final acknowledged delivery. A future design would need a qualified
common elapsed-time measurement and permanent exhausted-target outcome;
blocked completion may remain outstanding past 600. This is a coverage gap,
not a demand for a hard syscall/reap bound.
[service/callbacks/host-run-endpoint.ts:478–490](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L478-L490),
[core/host-runs/host-run-launch.ts:31–58](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-launch.ts#L31-L58),
[core/machine/process-exec.ts:252–262](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L252-L262),
[service/executor/host-run-supervisor.ts:192–200](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/executor/host-run-supervisor.ts#L192-L200), [cooperative-qualification.md:23–30](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L23-L30).

No resource sampling or runtime probe was authorized here. **Measured coverage:
none; no observed high-water mark or 512 MiB fit is claimed.** A later scoped
route must inventory and measure the following, including coexisting copies:

| Charged footprint | Source-backed accounting boundary |
| --- | --- |
| Nucleus DB, WAL, scheduler records and ordered journal; partial/failure writes | WAL/FULL persistence is configured independently of proof scratch; host-run journal is transition evidence. Neither implies reserved disk capacity. [core/store/store-admission.ts:252–253](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/store/store-admission.ts#L252-L253), [shared/schema/host-runs.ts:156–164](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L156-L164). |
| Submission/env, plan/state/cancel/disconnect, results/retention and temporary publications | Owned file paths and verified atomic publication exist; temporary and final bytes and failures must be charged. Directory fsync failure is nonfatal. [core/host-runs/host-run-files.ts:263–278](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-files.ts#L263-L278), [core/host-runs/host-run-files.ts:555–594](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-files.ts#L555-L594). |
| Raw source/tree/index, manifests, inputs, capture, Effigy prepare DB/WAL/ring/gates and work | Source checks bind a tree, not these storage totals. Effigy #1017 reports prepare storage outside later admission and logical/post-checkpoint limits only. [core/qa/proof-source.ts:21–59](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/proof-source.ts#L21-L59), [docs/knowledge/specs/063-proof-execution-host-runs.md:252–269](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L252-L269). |
| Output, delivery buffers, originals and evidence copies, failed retention and later cleanup | Retained streams have per-stream caps; proof files coexist with copied evidence. Retention failures preserve unresolved bytes. All copies and delivery providers stay charged. [core/host-runs/host-run-endpoint-types.ts:49–56](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-endpoint-types.ts#L49-L56), [core/intake/proof-files.ts:100–142](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-files.ts#L100-L142), [core/host-runs/host-run-retention.ts:63–94](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-retention.ts#L63-L94). |
| External backing, residual allocations, APFS metadata/COW and allocation rounding | Container removal is a separately reported fact, not physical absence. Unknown physical costs must be disclosed, not counted as zero or a fabricated reserve. [docs/knowledge/contracts/host-run-scheduling-010.md:181–189](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/contracts/host-run-scheduling-010.md#L181-L189), [cooperative-qualification.md:32–58](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L32-L58), [cooperative-qualification.md:84–94](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L84-L94). |

For each actual root/provider a later route must record device, scope, method,
units, timestamp/freshness, missing coverage and sampled high-water mark.
Samples prove only their observation times. Monitor the combined 512 MiB
(384 + 128 planning, no free outside part), account retention beyond timeout,
and refuse unknown ownership/writers/required coverage/reserve safety.
Check the cooperative 22 GiB (20 + 2) threshold before effects and stop/report
detected loss. That threshold reserves no space against other writers.
Unknown all-physical peak alone is disclosed and unguaranteed, not failure;
unknown required safety inputs refuse/fail. [cooperative-qualification.md:32–58](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L32-L58).
Current capacity samples cover CPU/memory, not this storage ledger or reserve
safety ([shared/schema/host-runs.ts:102–117](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L102-L117)).

## Complete capture and delivery

The required conjunction is raw EOF **and** full drain **and** successful
fsync **and** source binding **and** in-target acknowledgement **and** publisher
positive wait/reap, alongside attributable Effigy completion. No second-log,
8 MiB, redaction or compression exemption applies. [cooperative-qualification.md:62–71](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L62-L71), [cooperative-qualification.md:96–104](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L96-L104).

Existing capture does not qualify: supervisor output uses an 8 MiB per-stream
cap and token redaction; close swallows flush/fsync errors. Chunk-observer
errors are swallowed too. Group settlement can destroy pipes after one event
loop turn without requiring `pipesClosed`. Closing output before the result
therefore does not prove EOF/drain/sync success.
[core/host-runs/host-run-endpoint-types.ts:49–56](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-endpoint-types.ts#L49-L56),
[core/host-runs/host-run-retained-output.ts:35–85](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-retained-output.ts#L35-L85),
[core/machine/process-exec.ts:219–246](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L219-L246),
[core/machine/process-exec.ts:278–301](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L278-L301),
[service/executor/host-run-supervisor.ts:168–173](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/executor/host-run-supervisor.ts#L168-L173).

Proof-file hashing/copy and callback tree checks credit source-bound evidence,
not a complete raw-delivery protocol: the copy uses `writeFileSync`, with no
explicit successful fsync receipt, capture acknowledgement or publisher wait
in that path. The proof result accepts status/selector/exit/bounded text, not
that conjunction. Larger caps or an uncharged second log would not repair it.
[core/intake/proof-files.ts:123–142](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-files.ts#L123-L142),
[core/intake/callback-intake.ts:201–212](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/callback-intake.ts#L201-L212),
[shared/schema/review/proof.ts:27–33](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/review/proof.ts#L27-L33).

## Finite written control and refusal plan

This is the written control plan for the proposed finite attempt record, not
executable controls. The proposal seam map below supplies each future owner;
the current-source column preserves the original audit.
Evaluate every row independently as proved/disproved/unknown; missing, stale,
unreadable, wrong-subject or timed-out required evidence is never proved.
Before any mandatory effect, unproved prerequisites return REFUSE. After an
effect, disproved obligations return FAILED/SPENT/retained; unresolved ones
return unknown/SPENT/retained, with the original fault permanent. A hit target
is FAILED even if closure remains unknown. [cooperative-qualification.md:96–128](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L96-L128).

| Independent gate | Required control / counterexample disposition | Current source boundary |
| --- | --- | --- |
| Exact source and authority | Bind head/tree, ordered inputs, run, participant, authority, executable/argv/cwd/effective env and t0. Require all 445 cases and genuine admission/completion on the actual Effigy selector; reject substitutions and maintenance-as-admission. | Proof/tree checks and intent exist, but no end-to-end host proof binding. [core/dispatch/run-launch/run-intent.ts:17–82](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/dispatch/run-launch/run-intent.ts#L17-L82), [core/qa/proof-source.ts:21–59](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/proof-source.ts#L21-L59), [cooperative-qualification.md:62–71](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L62-L71). |
| Time target | Count every effect from t0; at 600 stop qualification through a supported safe stop, mark FAILED permanently, preserve outstanding parents/waits/storage. Late completion cannot PASS. | Launch/spawn clocks do not cover the full interval. [core/host-runs/host-run-launch.ts:31–58](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-launch.ts#L31-L58), [core/machine/process-exec.ts:252–262](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L252-L262), [cooperative-qualification.md:14–30](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L14-L30). |
| Storage safety | Require fresh complete monitored coverage and known 22 GiB threshold safety; overflow/breach fails after effects; stale/unreadable required samples stay unknown. Disclose physical peak uncertainty independently. | CPU/memory reservation is not a disk ledger. [shared/schema/host-runs.ts:102–117](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L102-L117), [cooperative-qualification.md:32–58](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L32-L58). |
| Actual custody and safe stop | Establish surviving actual parent handles before effects, through stop/report failure/turn release. Never KILL the last custodian. Unsupported owner death stays unknown/SPENT/retained; do not invent an adopter. | PID-returning supervisor and whole-group stop do not qualify. [core/qa/supervisor-process.ts:46–55](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/supervisor-process.ts#L46-L55), [core/machine/process-exec.ts:139–175](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L139-L175), [cooperative-qualification.md:73–82](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L73-L82). |
| Positive waits/reaps | Require every exact required child's actual surviving parent wait/reap, including S, actor, custodian, monitor, leaves and publisher where created. Empty group, identity, capacity and EOF cannot substitute. | Direct command exit only; ESRCH polling is not wait authority. [core/machine/process-exec.ts:293–301](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L293-L301), [core/machine/process-group.ts:81–98](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-group.ts#L81-L98), [cooperative-qualification.md:73–82](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L73-L82). |
| DECIDING census and join | Require qualified completed exact-custodian/attempt-bound census and positively completed join. Lost/timed-out join or wrong/missing census fails/stays unknown even with all positive waits. | No qualified receipt in result/settlement. [shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92), [cooperative-qualification.md:84–98](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L84-L98). |
| FINAL census | Independently require certain-empty exact-group final census. Missing/unknown/nonempty FINAL cannot be discharged by DECIDING/join or waits. | Group observation has no qualified final-census provenance. [core/machine/process-group.ts:81–98](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-group.ts#L81-L98), [shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92), [cooperative-qualification.md:84–98](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L84-L98). |
| Whole backing and residual absence | Where the proof owns an image, require ordinary provider evidence that the entire backing and residual allocations are absent. Detach/unmount/unlink/container flags/group emptiness fail this gate; retained evidence elsewhere stays charged. | No such provider receipt in settlement. [shared/schema/host-runs.ts:69–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L69-L92), [cooperative-qualification.md:84–94](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L84-L94). |
| Capture and acknowledged delivery | Require complete raw EOF, drain, successful fsync, binding, in-target ack and publisher reap separately. Normal exit with partial capture fails; lost sync/ack/wait is unknown/failed, never PASS. | Capped/redacted output, swallowed faults and early pipe destruction do not qualify. [core/host-runs/host-run-retained-output.ts:35–85](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-retained-output.ts#L35-L85), [core/machine/process-exec.ts:219–246](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L219-L246), [cooperative-qualification.md:96–128](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L96-L128). |
| Retention / loss / dependent work | Preserve first fault, spent occurrence and every unresolved parent/backing/accounting obligation. No automatic retry, refund, reset, cleanup, fresh occurrence or dependent lifecycle work while unknown/retained. Later reconciliation can settle closure only. | Existing single-flight/spent settlement is narrower than this complete cooperative lifecycle. [core/qa/proof-admission.ts:28–45](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/proof-admission.ts#L28-L45), [core/intake/proof-settlement.ts:45–62](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-settlement.ts#L45-L62), [cooperative-qualification.md:99–104](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L99-L104). |

Every applicable row is conjunctive. In particular, all waits plus a lost
DECIDING join still fail; all waits and DECIDING plus missing FINAL still fail;
all three plus missing backing absence still fail where applicable. This
preserves the contract's counterexamples rather than upgrading a terminal
host result or later cleanup to PASS. [cooperative-qualification.md:106–128](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L106-L128).

## Provider dependencies and acceptance mapped to source

Effigy #1017's four verdicts remain historical facts: physical enclosure
unsupported; independently surviving prepare parent/hard-total-time conjunction
unsupported; maintenance versus genuine later admission supported with limits;
all-role custody unsupported (direct actor only supported with limits).
The base attributes these to the pinned report
([docs/knowledge/specs/063-proof-execution-host-runs.md:252–280](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L252-L280)).
The cooperative contract removes the need to qualify the old hard physical/time
parts; it does not upgrade the actual-parent, admission or capture evidence
([cooperative-qualification.md:130–150](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L130-L150)). No upstream capability from #1017's rejected prepare-custody
candidate is assumed implemented or selected here.

The actual dependencies are Effigy's runtime/prepare owners for real admission,
first-effect coverage and the supported direct-child boundaries; the
application owner for A/C/M/L creation and retained wait relationships; the
actual backing provider for whole-image/residual absence; and the existing
Nucleus capture/callback/retention owners for complete acknowledged raw
evidence. These are required evidence suppliers, not newly invented
controllers/services/providers. No qualified supplier for the complete
conjunction is identified by the unchanged paths audited above; the proposal
below makes the missing interfaces explicit conditions. [cooperative-qualification.md:62–104](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L62-L104),
[shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92),
[docs/knowledge/specs/063-proof-execution-host-runs.md:274–280](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L274-L280).

A separately scoped route could be accepted only against all control-plan
rows, with qualified source and applicable provider evidence for each. The
source map is the surface table and per-gate citations above: identity goes to
proof source/intent and actual Effigy admission; resource coverage to the
first-effect clock and complete ledger; custody to actual spawn/wait paths;
censuses/backing to distinct qualified receipts; capture to EOF/drain/sync/ack
and publisher wait; loss to permanent spent retention. No row grants another's
credit. The retained reviewer judges this document at its exact PR head;
repository docs validation establishes documentation validity only, never
native qualification ([cooperative-qualification.md:96–104](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L96-L104), [cooperative-qualification.md:152–170](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L152-L170)).

## Preserved audit conclusion: unchanged route

**Existing route: no-fit.** Relaxing time to a cumulative target and scratch
to monitored accounting removes the original hard-bound objections, but the smallest
existing-route candidate still cannot supply:

- surviving actual direct-parent custody, positive wait/reap for every required
  child and publisher, and a stop route protecting the last custodian
  ([core/qa/supervisor-process.ts:46–55](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/qa/supervisor-process.ts#L46-L55), [core/machine/process-exec.ts:139–175](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L139-L175),
  [docs/knowledge/specs/063-proof-execution-host-runs.md:274–280](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L274-L280));
- a qualified completed/joined custodian-bound DECIDING census, independently a
  qualified FINAL certain-empty census, and applicable whole-backing plus
  residual-allocation absence evidence ([shared/schema/host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L48-L92),
  [core/machine/process-group.ts:81–98](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-group.ts#L81-L98));
- complete raw EOF/drain, successful fsync, source-bound in-target
  acknowledgement and publisher reap ([core/host-runs/host-run-retained-output.ts:35–85](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/host-runs/host-run-retained-output.ts#L35-L85),
  [core/machine/process-exec.ts:219–246](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L219-L246), [core/intake/proof-files.ts:123–142](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/intake/proof-files.ts#L123-L142));
- an integrated first-effect target/permanent-no-late-PASS and fresh complete
  monitored-storage/reserve-safety accounting route
  ([service/callbacks/host-run-endpoint.ts:478–490](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/service/callbacks/host-run-endpoint.ts#L478-L490),
  [core/machine/process-exec.ts:252–262](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/core/machine/process-exec.ts#L252-L262), [shared/schema/host-runs.ts:102–117](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/host-runs.ts#L102-L117),
  [shared/schema/review/proof.ts:27–33](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/shared/schema/review/proof.ts#L27-L33), [cooperative-qualification.md:14–58](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L14-L58)).

These are current-code gaps, not evidence that bounded changes cannot fit.
Implementation still needs a separately scoped, reviewed brief; the unchanged
native 445-case ladder remains separate and unactivated.
[cooperative-qualification.md:152–170](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L152-L170). The future route is conditional as set out below.

## One smallest conditional proposal

Use the existing host-run supervisor for one direct Effigy command, with an
opt-in qualification mode in its existing plan, process execution, capture,
watch and retention code. Bind it to the existing proof subject and authenticated
callback. The bound executor submits that command once and reports the
settlement digest through its own callback; it never also runs the selector
locally. Keep Effigy responsible for real workload admission and custody;
Nucleus's host reservation supplies no substitute admission. Add no controller,
provider, service, subreaper or portable parent-handle transfer. Ordinary host
runs keep their existing protocol; qualification evidence is private beside
those records, not a reinterpretation of Contract 010's pinned result.

This selects a future design, not executable authority. The proposed names in
the next table are new APIs/fields **inside the named existing files**. Each
citation is to the seam at base `5ae03a1d1b6c40460567aa55380869b378be9dd6`.

| Seam | Concrete future change and record |
| --- | --- |
| P1 — proof subject and submit | Extend `proofExecutionRecordSchema` in `shared/schema/review/proof.ts` with a private qualification reference/digest. Extend `runSchema.proofExecution` and `hostRunSupervisorPlanSchema` with the qualification binding. Add `HostRunEndpoint.submitQualification` around the existing `onSubmit`/`launch` seam: authenticate the existing executor-run credential and resolve its immutable subject before any submit write; a host token or client-supplied caller grants no proof authority. In `runIntent` carry the exact binding: task/run/participant, authorization and operation, brief digest/version, published head/tree, ordered inputs, actual selector and host run/epoch. Bind executable digest, literal argv, cwd and a canonical digest of **effective environment values**, not just names. Recheck with `verifyProofSource` before effects and acceptance; no shell or synthetic admission token. [proof.ts:11–64](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/shared/schema/review/proof.ts#L11-L64), [runs.ts:95–108](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/shared/schema/runs.ts#L95-L108), [host-run-wire.ts:67–79](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-wire.ts#L67-L79), [run-intent.ts:17–82](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/dispatch/run-launch/run-intent.ts#L17-L82), [host-run-endpoint.ts:463–491](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/callbacks/host-run-endpoint.ts#L463-L491), [host-run-endpoint.ts:544–578](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/callbacks/host-run-endpoint.ts#L544-L578), [proof-source.ts:21–59](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/qa/proof-source.ts#L21-L59). |
| P2 — retained actual children | Add an opt-in retained-child return to `spawnDetachedSupervisor`, plumbed through `defaultSupervisorSpawn`; service retains S's actual child exit promise for the whole attempt. Extend `ExecutionRequest`/`ExecutionOutcome` in `executeHookProgram` with `onChildExit` and `directChildWait`: parent/child start identities, exit code/signal, observation tick and observed/unknown state. S records its **own** direct-command exit observation before group settlement; no census, EOF or PID poll can synthesize it. `runHostRunSupervisorMain` retains the observation. [supervisor-process.ts:24–55](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/qa/supervisor-process.ts#L24-L55), [host-run-endpoint.ts:137–143](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/callbacks/host-run-endpoint.ts#L137-L143), [process-exec.ts:11–82](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/machine/process-exec.ts#L11-L82), [process-exec.ts:293–301](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/machine/process-exec.ts#L293-L301), [host-run-supervisor.ts:96–174](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/executor/host-run-supervisor.ts#L96-L174). |
| P3 — qualification stop | Add `stopMode: qualification_direct` to the private supervisor plan and `ExecutionRequest`. Every timeout, cancel, capture/storage failure and exception in this mode requests cooperative stop by signalling **only the still-held direct command** with TERM. Disable group signals, escaped-descendant signals and KILL escalation, including fallback paths. Do not terminate S as a cleanup shortcut. If the direct command cannot cooperate while preserving its child obligations, refuse this composition; after an effect, retain unknown closure instead of escalating. Endpoint `cancelRun` persists this mode's request. [host-run-wire.ts:67–105](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-wire.ts#L67-L105), [process-exec.ts:139–175](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/machine/process-exec.ts#L139-L175), [host-run-endpoint.ts:652–677](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/callbacks/host-run-endpoint.ts#L652-L677). |
| P4 — raw capture and publication | Extend `openHostRunRetainedOutput` with qualification raw mode: retain every stdout/stderr byte at the existing owned paths, without the 8 MiB cap, redaction, compression or a second log. `close()` returns per-stream EOF/drain/byte-count/hash/write/flush/fsync/close evidence and explicit faults. `executeHookProgram` propagates observer errors and awaits real pipe EOF/drain; it cannot destroy pipes to manufacture completion. Add strict durability reporting to `writeVerifiedOwnedFile`, including directory fsync failures, for qualification publications. Private raw bytes remain access controlled and out of default UI/exports; diagnostic views cannot stand in for them. [host-run-retained-output.ts:16–85](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-retained-output.ts#L16-L85), [process-exec.ts:219–301](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/machine/process-exec.ts#L219-L301), [host-run-files.ts:555–594](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-files.ts#L555-L594). |
| P5 — cumulative clock and storage | Extend the private plan in `host-run-wire.ts` with `firstEffectClock {clockId, originTick, targetMs: 600000}`; `DispatchLaunch.proofExecution` in `core/dispatch/launch.ts` establishes that origin before entering the dispatch funnel, including reservation persistence; `runIntent` and `onSubmit` consume it, never start a launch clock. If any mandatory prepare/capture/copy or execution-activation persistence precedes this entry, its owner must supply the earlier qualified origin before that effect, or the route refuses. Retries never reset it. In the existing endpoint/supervisor add `storageLedger` entries for the full inventory above: root/provider/device, owner/writers, method/units, sample tick/freshness, bytes/high-water, missing coverage and reserve safety. Include attributable DB/WAL/journal writes (charge the entire shared footprint if attribution cannot be proven), temporary/final publications, streams, all source/evidence copies and retained failures. Monitor combined 512 MiB and 22 GiB start/abort safety; overflow or breach latches failure and P3 stop. Logical sampling never claims an all-physical peak. [launch.ts:85–99](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/dispatch/launch.ts#L85-L99), [reserve.ts:25–46](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/dispatch/run-launch/reserve.ts#L25-L46), [host-run-wire.ts:67–96](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-wire.ts#L67-L96), [host-run-endpoint.ts:478–490](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/callbacks/host-run-endpoint.ts#L478-L490), [host-run-supervisor.ts:96–200](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/service/executor/host-run-supervisor.ts#L96-L200), [host-runs.ts:102–117](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/shared/schema/host-runs.ts#L102-L117), [store-admission.ts:252–253](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/store/store-admission.ts#L252-L253). |
| P6 — typed evidence and acceptance | Define private `hostRunQualificationObservationSchema`, `hostRunQualificationAckSchema` and `hostRunQualificationSettlementSchema` in `shared/schema/host-runs.ts`; name their owned per-run sidecars in `hostRunSupervisorPaths`. S alone writes `qualification.observation.json`; the endpoint alone writes `qualification.ack.json` and `qualification.settlement.json`. Observation binds the subject, direct-child wait, provider receipts, capture and ledger; ack binds subject, raw lengths/hashes, observation digest and durable acceptance tick. Settlement records the service's S wait and each independent gate, not a single inferred `closed` flag. Extend `proofExecutionResultSchema` with a qualification digest for this mode, `HostRunWatch.settleFromResult` to validate those receipts, and `proofResultRefusal`/callback intake to consume the exact settlement digest with the executor's existing authentication. Pass references to these retained raw files, not bounded `proofFiles` copies; any additional copy stays charged and needs its own delivery evidence. Contract 010 exit zero alone supplies no qualification verdict. [host-runs.ts:48–92](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/shared/schema/host-runs.ts#L48-L92), [host-run-files.ts:263–278](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-files.ts#L263-L278), [host-run-watch.ts:227–251](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-watch.ts#L227-L251), [proof.ts:27–33](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/shared/schema/review/proof.ts#L27-L33), [proof-settlement.ts:18–24](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/intake/proof-settlement.ts#L18-L24), [callback-intake.ts:201–212](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/intake/callback-intake.ts#L201-L212). |
| P7 — spent retention and loss | Extend `settleProofExecution` and `HostRunWatch` with qualification dispositions that preserve `firstFault`, `spent`, unresolved obligations and separate target/workload/evidence/resources/closure outcomes. Service→S parent loss is unknown/SPENT/retained; a **Nucleus roll during a proof spends it**, even if S survives and later writes a result. Restart only reads/reconciles that evidence; it cannot restore wait credit or PASS. In `HostRunRetention.sweepRetainedOutput`/`settleRetainedOutput`, keep qualification raw bytes, sidecars and charged residuals while unresolved; the ordinary expiry marker is no deletion authority. [host-run-watch.ts:100–150](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-watch.ts#L100-L150), [proof-settlement.ts:45–84](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/intake/proof-settlement.ts#L45-L84), [host-run-retention.ts:98–150](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-retention.ts#L98-L150), [host-run-retention.ts:394–444](https://github.com/inflatable-cookie/nucleus/blob/5ae03a1d1b6c40460567aa55380869b378be9dd6/core/host-runs/host-run-retention.ts#L394-L444). |

P6's typed settlement fields are `directChildWait`, `parentWaits`,
`decidingCensus` (sequence and exact named message), `censusJoin` (the qualified
join record), `finalCensus` (the separate final summary), `backing`, `capture`,
`delivery`, `storageLedger`, `firstFault` and `spent`, alongside the separate
outcomes. Each provider receipt includes its subject and source/digest
provenance. `backing` initially has only an explicit unknown/policy-unresolved
variant; an owner-defined evidence variant is a later condition, not an empty
receipt accepted as absence. Missing legacy fields stay unknown. The gate map
below defines the separate capture and acceptance fields; no aggregate success
bit can fill an absent one.

The finite successful graph is **service → S → Effigy E → actor A →
custodian C → monitor M / leaves L**, with each actual creator retaining its
own child handle. This is the required conditional topology: any additional
fork/helper adds its real creation edge and wait receipt; role labels cannot
collapse actual children. Effigy prepare children add their actual edges under E's
prepare owner before prepare effects. No shell is inserted. S also publishes
Nucleus's capture, so service→S is its publisher wait; any Effigy/Oxide
publisher adds a separate creator-owned wait. S's E exit observation proves
only S→E, never E→A or A→C. The live service must positively observe S's exit;
service loss forfeits that edge, with no claimed successor.

Publication order is finite: S observes command exit and all supplied child
receipts, finishes real EOF/drain/fsync, and publishes its observation. The
endpoint validates/source-binds and durably acknowledges the raw artifact
hashes; S observes that exact ack and exits. The service then observes S's
exit and writes the full settlement. The bound executor reports its digest;
the service validates and durably accepts that authenticated callback within
the original target, checking elapsed time after required durability work. It
never waits for S before sending the raw ack. Any blocked step can outlast 600 seconds; qualification fails at the
target, while actual parents and storage owners keep outstanding obligations.
A lost acknowledgement is not permission to publish, execute or copy again
blindly; read the same subject-bound durable record.

### Interfaces required from existing Effigy and Oxide owners

These are required contracts, not implementations or claims that dependencies
already supply them:

- **Effigy admission, prepare and E→A:** Effigy must report genuine admission
  and attributable completion for the exact selector, with no maintenance
  substitution. Its prepare owner must hold/wait its actual prepare children
  before effects, bind the same first-effect origin and inventory all prepare
  DB/WAL/ring/gate storage. E's cooperative direct-command stop must preserve
  its waits and the last custodian. #1017's old `fits:false` remains unchanged;
  its rejected candidate supplies no readiness credit. The reported seams are
  `src/runner/run_control.rs:95–147`,
  `src/runner/task_engine/run/foreground.rs:181–225` and
  `crates/effigy-kernel/src/custody/spawn.rs:741–787` at Effigy
  `dc6f5abf5a5c5e37658b7048e9f8cc644df48709`, attributed by the
  [pinned cooperative contract:143–150](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L143-L150).
- **Oxide A→C→M/L and publishers:** each creator supplies a subject-bound
  positive wait/reap receipt for its exact child: parent/child start identities,
  role, exit observation and status. Receipt copies convey evidence, never wait
  authority. Each owner must survive its supported stop/report/turn-release
  path; unsupported owner loss remains unknown/SPENT/retained. Nucleus cannot
  construct those application edges from S's direct child.
- **Qualified census:** consume the Oxide #195 / [PR 188](https://github.com/inflatable-cookie/oxide/pull/188)
  ordinary-guard baseline, inspected at Oxide
  `fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25`, whose
  `scripts/bounded-test.py` digest is
  `fcfda2b0a43afd192a4f75e0d575b9aa94f0fd79d195bd75b1c66305f37f046b`.
  Retain `deciding_census_seq` and its exact monitor-sent, custodian-named
  `deciding_census {certain, members, uncertain}`; independently retain
  `census_join {joined, started, bound_s, waited_ns, rows, deciding, final,
  frozen?, refused?}` and the FINAL round. Bind the receipt's bytes/digest,
  producer source, actual custodian/attempt and exact closure group in P6.
  `census_settled` requires **joined AND FINAL certain-empty AND the exact
  named DECIDING certain-empty**; a vacuous join alone proves no census.
  [bounded-test.py:1790–1832](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/bounded-test.py#L1790-L1832),
  [bounded-test.py:4474–4542](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/bounded-test.py#L4474-L4542).
  The #309 `scripts/bounded-test-ceiling.py` candidate clips `join_census` to
  the remaining ceiling; it is **unqualified**, not interchangeable with that
  baseline. Any new composition needs its own later 445-case ladder.
  Conservative UNCLOSED under host churn is a permitted failure, not evidence
  that a platform capability is required.
  [bounded-test-ceiling.py:4613–4656](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/bounded-test-ceiling.py#L4613-L4656).
- **Backing policy, then evidence:** once the owners settle the conflict below,
  the existing backing owner must define and supply ordinary provider evidence
  of the unchanged whole-backing/residual-absence gate. P6 keeps `backing`
  unknown until that evidence is defined, source-bound and qualified. No new
  backing provider is selected or built by this proposal.

### Unresolved image-backing owner policy

The 445-case suite owns real images. At Oxide
`fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25`, its detach fixtures create
8 MiB APFS sparse images under case evidence, publish the requested backing
identity and detach their fixture mounts:
[test_supervisor_ceiling_qualification.py:10444–10545](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/test_supervisor_ceiling_qualification.py#L10444-L10545),
[fixture detach:10573–10583](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/test_supervisor_ceiling_qualification.py#L10573-L10583).
The positive oracle `test_success_detaches_exactly_the_requested_volume`
requires `os.path.isfile(self.volume["image"])` after success: removing the
retained image fails that preserved oracle.
[positive oracle:10585–10596](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/test_supervisor_ceiling_qualification.py#L10585-L10596).
A separate case preserves the owned root on unknown image custody even with
settled census evidence.
[unknown custody:10838–10854](https://github.com/inflatable-cookie/oxide/blob/fc6b2aebdf2b86ca09243b539f84cfd1b1da5a25/scripts/test_supervisor_ceiling_qualification.py#L10838-L10854).

The adopted contract independently requires the entire owned backing and its
residual allocations absent; detach/unmount does not suffice.
[cooperative-qualification.md:84–94](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L84-L94).
**This is an unresolved owner-policy conflict if “backing” includes the
retained image file.** It exists independently of provider capability. This
proposal neither picks a reading of “backing”, exempts suite images, deletes
the positive oracle, nor weakens the gate. Without an owner ruling, the backing
predicate cannot be met as written. Code cannot supply the missing policy;
backing evidence stays unknown and execution readiness stays false.

### Conditions and acceptance-to-source map

The proposal relies on, and does not supply: Effigy's prepare custody, real
admission/completion and cooperative stop; Oxide's creator-owned child waits
and qualified census composition; a qualified common elapsed clock across the
participating processes (no assumed conversion to Oxide's RAW clock); complete
root/writer/storage/reserve coverage and measured fit; successful raw capture
and durable in-window delivery; the backing owners' policy ruling **and then**
qualified backing evidence. The #309 changed join is a separate unqualified
code dependency, not that policy ruling. Readiness requires every condition;
none of them is waived by selecting the design.

P6 records each gate as proved/disproved/unknown with evidence provenance and
its own observation tick. The following map is also the expansion of the
control plan above: evaluate **each row separately and conjunctively**, even
where the audit grouped related capture or resource facts. Before any effect,
an unproved prerequisite refuses; after effects, a disproved gate fails and
an unresolved gate stays unknown, both SPENT/retained. No row supplies another
row's credit.

| Independent obligation in proposal and control plan | Future source / written control |
| --- | --- |
| Exact source, inputs and authority | P1/P6: reject changed head/tree, ordered inputs, participant, authority, command or effective-env digest; recheck before acceptance. |
| All 445 cases | P1/P6 + Oxide suite: require the unchanged complete case set; no reduced suite or inherited packet credit. |
| Preserved positive and negative oracles | P6 + owners: reject any weakened/reinterpreted oracle, including the image conflict; missing owner resolution refuses readiness. |
| Genuine selector admission | P1 + Effigy: require its actual selector admission receipt; host capacity and prepare are not substitutes. |
| Attributable Effigy completion | P6 + Effigy: retain completion for that admitted run; command exit alone cannot prove it. |
| One cumulative time target | P5/P7: t0 precedes first mandatory effect; 560/530/20/2 allocations overlap within 600 seconds. Hit target permanently fails qualification; late completion settles closure only. |
| Complete monitored scratch coverage | P5: inventory every provider/root/writer, coexisting copy and failure remnant with fresh samples and explicit missing coverage; refuse unknown required safety inputs. |
| 512 MiB monitored target | P5: 384 + 128 stays within 512; known breach or accounting overflow fails/stops. Disclose unguaranteed metadata/COW/physical peak separately. |
| 22 GiB reserve safety | P5: unknown/below threshold refuses before effects; detected loss requests P3 stop and retains obligations; no reservation claim. |
| Surviving actual parent graph, including prepare | P2 + Effigy/Oxide creators: require actual handles before their effects; unsupported owner loss stays unknown, never an invented adopter. |
| Safe stop protecting the last custodian | P3: direct-command cooperative signal only; no group/escapee/KILL fallback. Unsupported safe stop refuses composition. |
| Every required positive child wait/reap | P2/P6 + actual creators: separately prove S, E, A, C, M, leaves and each created publisher as applicable; ESRCH/group/EOF never substitutes. |
| Exact custodian-bound DECIDING census | P6 + qualified Oxide baseline: require the exact named monitor-sent certain-empty message for this attempt/group; reject missing/wrong binding. |
| Completed census join | P6 + Oxide: require the completed join and its final published evidence, no frozen prefix upgraded to closure. A changed candidate needs later qualification. |
| Separate FINAL certain-empty census | P6 + Oxide: require independently of DECIDING/join and waits; nonempty/uncertain/missing FINAL cannot pass. |
| Entire backing and residual allocations absent | P6 + backing owners: require ordinary provider evidence under owner-resolved policy; detach, unmount, unlink or container removal alone is insufficient. Unknown retains backing/accounting. |
| Complete raw capture | P4: require exact bytes/lengths/hashes, no cap/redaction/compression exemption; partial or overflow fails even on exit zero. |
| Raw EOF | P4: real EOF on every required stream, never forced pipe destruction or group emptiness. Missing EOF stays unresolved. |
| Full drain | P4: all observed bytes reach retained storage; EOF without completed writes is insufficient. |
| Successful fsync | P4/P6: every required stream and publication sync succeeds; record file/directory failures explicitly. Lost sync is unknown, observed failure fails. |
| Source-bound delivery | P1/P6: raw artifact and receipt hashes bind the exact subject; reject stale or wrong-source evidence. |
| In-target durable acknowledgement | P6: ack exact raw lengths/hashes/observation digest and final authenticated acceptance before t0+600; missing/lost/late ack never passes. |
| Publisher positive wait/reap | P2/P6: service positively waits S after raw ack, plus each actual creator's additional publisher wait; ack alone cannot discharge it. |
| Permanent first fault, spent retention and dependent-work hold | P7: target/workload/evidence/resources/closure remain separate. Roll or unsupported service→S loss spends the proof; no replay, refund, fresh occurrence, automatic cleanup or dependent lifecycle work. Later supported reconciliation changes closure only. |

A later implementation brief can use P1–P7 as its source/acceptance map and
this finite plan as its refusal oracle. It must qualify the common clock,
resource measurements and complete receipt composition before separately
activated adequate uncounted diagnostic, counted author, distinct retained
reviewer and final exact-head disposition. The native **445-case** ladder and
309 publication → 061 → 304 remain unactivated; historical resources and
receipts remain untouched. This PR supplies only the proposal and one retained
independent review, whose full verdict belongs in its exact-head report.

**Disposition: conditional proposal; implementation readiness false.** No
additional predicate has been shown impossible under bounded changes in these
existing components. The backing policy conflict prevents satisfying its gate
as written until the owners rule; that is not a provider no-fit. Every other
missing dependency remains explicit rather than being credited as implemented.
