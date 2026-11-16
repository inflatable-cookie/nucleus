# 064 — Proof execution under cooperative qualification

Status: no-fit
Scope: route assessment only; no implementation or proof activation

## Authority and changed premises

Tom adopted Oxide's cooperative qualification contract for future oxide#309
work on 2026-11-16 and authorized one independently reviewed Nucleus route
assessment only. The pinned document still calls itself proposed; adoption
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

All Nucleus source citations below name this PR's base commit,
`bc27bf69ea9beccddfb91785653fa2a72bb3e2fe`. Contract citations name the pinned
Oxide merge above. Effigy dependencies are attributed to the complete
Nucleus-held `v015-qualification` v19 report, read for this assessment, digest
`sha256:368de92769966ffbc992f286e28324f7207c25e7573f8738fb82d20a8dd874b1`,
auditing Effigy `dc6f5abf5a5c5e37658b7048e9f8cc644df48709`. The base already
records that provenance and its limits
([docs/knowledge/specs/063-proof-execution-host-runs.md:20–29](https://github.com/inflatable-cookie/nucleus/blob/bc27bf69ea9beccddfb91785653fa2a72bb3e2fe/docs/knowledge/specs/063-proof-execution-host-runs.md#L20-L29)). This is source
inspection and a written refusal plan; it supplies no native measurements,
qualification credit, new provider or execution authority.

## One assessed route and its exact surface

The smallest route assessed is to bind the existing proof executor's subject
to one existing host-run submission, retain that run's output and settlement,
then accept its evidence through the existing authenticated proof callback.
**This candidate is rejected below.** These are the existing seams a separately
scoped design would have to address, not a selected implementation or new API:

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
No new file, API or record is selected for implementation by this no-fit.

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

This is a review oracle for one finite attempt record, not executable controls.
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
controllers/services/providers. No qualified supplier for the missing
conjunction is identified by the audited paths above. [cooperative-qualification.md:62–104](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L62-L104),
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

## Disposition

**no-fit.** Relaxing time to a cumulative target and scratch to monitored
accounting removes the original hard-bound objections, but the smallest
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

No implementation route or tranche is selected. Implementation needs a
separately scoped, reviewed brief after these support gaps are resolved;
the unchanged native 445-case ladder remains separate and unactivated.
[cooperative-qualification.md:152–170](https://github.com/inflatable-cookie/oxide/blob/f14c130c717b86dcdac4d6cb7d6c1cab8c3e17ed/docs/knowledge/contracts/cooperative-qualification.md#L152-L170). The single outcome is **no-fit**.
