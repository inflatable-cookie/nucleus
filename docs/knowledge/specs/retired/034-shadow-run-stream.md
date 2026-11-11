# 034 — Shadow-run stream producer

Status: retired (Tom, 2026-10-31, R3 in [vision](../../vision.md#simplification-rulings-2026-10-31)). The producer, `shadow.configure`/`shadow.status`, the shadow journal writer and the rotation seed export are removed; stream files, seed directories and recorded journal rows already written stay inert history. The design below is retained history.
Owner: Queue runtime maintainers
Created: 2026-09-30
Decision owner: Tom
Governing refs: the format is owned by Nucleus, contract 009 "Shadow-run stream"
(`docs/knowledge/contracts/009-shadow-run.md`; nucleus `ad2cbfb` added "JSONL
version 2: the producer speaks Queue", and nucleus `578acb1` added `assigned`
to request events; nucleus `c3b583b` adds scheduler authority, epoch, caller,
clientRequestId and run linkage; Nucleus
`533cb4b67a79c984ae8cb9c490b286910a184c99` amends contract 009 with a seed
export for every segment rotation; nucleus `0650526` amends contract 009 with a
rotating gap (`stream_gap` with `lostThroughSeq`), a 1 MiB line bound and a
rotation seed boundary naming the new segment). Tom approved the live shadow run on
29 September 2026 (Queue decision `3fc3e84f`) via Nucleus contract 001.
Nucleus `6b5185fc6afd5e1dc74d8db324704145f3efe8c8` adds the
`head_observed.source` field under contract 009, following Queue decision
`41375dca` in contract 002. Nucleus
`2a1634b3e2f1c8d103f24d47eaa585ed24b8f08b` adds profile availability
snapshots and the recorded `merge_intent` fact under contract 009. Nucleus
`4a3ec1b4628a2a1e9cb390a72a9c860b93bc258f` adds Spec 043's stage lifecycle
decisions and `wait_state` fact.

## Problem

Nucleus's shadow runner replays Queue's inputs and compares decisions. Tom
approved the live shadow run, and Queue owns producing the mirrored input
stream. Version 1 of contract 009 asked Queue for Nucleus-internal identities,
recording-plane claim keys and host proofs Queue never records; a worker stopped
there rather than guess. Version 2 moves all translation to the Nucleus feeder:
Queue writes its own identities and its own facts and decisions, and the feeder
maps them onto the shadow instance.

Producing the stream is observation only. It must not change a Queue decision,
add a failure mode to a Queue path or retry an unknown delivery. The stream is
read-only evidence the operator can inspect and a shadow run can replay.

## Queue's side

- **Setting.** `shadowStream` in the host's `settings.json`:
  `{"enabled": true, "directory": "shadow-stream"}`. Off by default. `directory`
  is relative to Queue's data directory (the plugin home's `northstar-queue`
  directory) and defaults to `shadow-stream`. The producer also accepts the same
  object from the Store `meta` key `shadowStream`, so a running host can be
  toggled without a restart: operator `shadow.configure {enabled, directory?}` sets
  that key through the service, and `shadow.status` reads the producer's counters,
  gaps and seed status. A settings-file object, when present, wins over the live
  `shadowStream` key and is recorded durably in the Store meta key
  `shadowStreamHost`, so the `records.export` child process (Spec 029, stream boundary)
  can resolve the same effective setting without reading `settings.json`. Files are
  `stream-0001.jsonl`, `stream-0002.jsonl`, ... and are readable by the operator.
  A `shadow.configure` that disables the stream settles and flushes its own
  request against the still-active stream before the setting takes effect, so the
  accepted toggle is not stranded in the journal behind the disabled guard. A
  producer fault during that flush is contained: the disabling setting still
  applies and the RPC still returns its status, and the settled request stays in
  the durable journal for the next enabled flush.
- **Journal.** One new operational table, `shadow_stream`, is the producer's
  durable outbox. A line is persisted there (with its Queue source identity,
  observed time, file and sequence) before any file append, so a crash between
  the two leaves a durable record to reconcile. It is listed in
  `OPERATIONAL_TABLES`, is never exported, and holds no Queue record.
- **Retention** (Tom, 2026-10-16; cut from 14 to 4 days by Tom, 2026-10-20, relayed by the Project-c Supervisor: "Yes to all your suggestions. We could go to 6 hourly, and manual backup on schema change? Reduce retention to 4 days"). An hourly pass deletes `written` and
  `discarded` rows older than 4 days from closed segments, in yielding
  batches. Pending, provisional and gap rows stay, and so does the whole
  current segment, which the rotation recount and the stream boundary read. A
  `host_run` row stays while its host-run journal row exists, so the journal
  replay can never re-emit it.
- **Observation.** The producer registers one read-only observer with the Store.
  For facts and decisions the Store notifies it from the durable write funnels
  that carry one — `event` and `putOutcome` — inside the same transaction. The
  producer assigns all lines from each Store observation to a segment as a
  group. The outcome observer runs before inserting the portable outcome row,
  so if its group starts a new segment the seed ends at the previous segment's
  boundary and does not include an outcome whose lines are in the new segment.
  The observer never raises: a producer fault cannot become a Queue failure mode.
- **Requests.** The producer registers one seam at the service's single dispatch
  point (`callCatalogueMethod`, shared by the socket service and the persistence
  executor worker). After the RPC's input is accepted and before its handler
  runs, every mutating method captures the request, so the request precedes the
  facts and decisions the handler causes and one rule covers the whole mutating
  catalogue instead of a per-method list that can drift. The catalogue marks every
  method mutating or read-only, and the classification test fails when a method is
  unclassified or changes side. A refused request — an unknown method, input that
  fails its contract, a handler that throws before it durably accepted, or the
  typed `{backpressured: true}` result several operation RPCs return — is omitted,
  never shown as accepted. An accept-then-wait RPC (`queue.submit`,
  `queue.submit-instruction`, an external-effect `queue.task`, `queue.handoff`)
  signals durable acceptance once its operation is stored, so a failure inside the
  compatibility window keeps the request rather than deleting it: Queue accepted
  the input and Nucleus must replay it.
  Read-only methods are never captured. `records.export` reads Queue state and
  stays read-only; `records.import`, `lead.import` and `papercut.import` mutate
  Queue records, so the stream carries their requests. Contract 009's feeder
  currently refuses those three import methods as request lines; the feeder's
  list must be relaxed (the Nucleus contract owner) before the live run consumes
  them, and Queue never silently drops the mutation.
- **Ordering.** The producer's sequence is replay order, and time order is the
  same order: a line's `at` never decreases as `seq` increases. A pushed-head
  proof that a request relies on is sequenced immediately before that
  provisional request, even though the fact's observed time can be later than
  the request's dispatch time. The journal clamps every line's `at` to no
  earlier than the previous line's in the same segment (`max(observed, last)`),
  in the transaction that assigns `seq`, so the clamp survives restarts. When a
  head proof is moved ahead of its request, the request and any later unstreamed
  lines are clamped forward. Rotation starts a new segment with no carried
  clamp. Other facts and decisions keep the notification order of their durable
  writes, and concurrent request arrivals retain their order.
- **Observed time.** A line whose `at` was clamped forward also carries
  `observedAt`, the original observation time (ISO UTC milliseconds, always
  earlier than `at`). Unclamped lines omit it. It is evidence only; replay order
  stays on `seq` and `at` (contract 009 allows the field).
- **Envelope.** Every line is one JSON object: `seq` (positive, contiguous from
  1 within a file), `at` (ISO 8601 UTC milliseconds, the durable record's own
  time or the dispatch time for a captured request, clamped as in Ordering), `id` (the Queue source
  identity plus the line's role, unique within the stream), `kind` (`request`,
  `fact` or `decision`) and `"v": 2`.
- **Request.** A Queue RPC method and its full input, captured at the dispatch
  point, plus contract 009's `assigned` (nucleus `578acb1`): the identities the
  accepted response assigned or advanced, copied from that response and never
  derived. A created or edited record — a lead, papercut, lane, lane document,
  project plan, decision, project, repository setting, any other record an
  accepted response returns — contributes the response's `id`, `version` and
  `digest`, whichever it returns, the digest only in its record `sha256:` shape
  so a QA run's argv digest is not mistaken for one. A promotion or submission
  (`lead.promote-task`, `papercut.promote-task`, `queue.submit`,
  `queue.submit-instruction`, a brief submission) contributes `taskId`,
  `reference` and `number`, renaming the task value the response returned under
  `id` or `task` to the contract's `taskId`. A field the response does not
  return stays absent, and a response that assigns nothing — `queue.control`,
  an operation acceptance, a settings response — omits `assigned` whole.
  `queue.submit` carries the submission, `queue.task` the control,
  `queue.control` `{"paused": ...}`, and a planning, lane, project or decision RPC
  its own input, so the stream mirrors the operator's inputs exactly as Queue
  accepted them. The request is journaled `provisional`; the flush never writes
  past an unsettled request, and a refused one is deleted with the rows behind it
  renumbered, so the refusal leaves no accepted event and no hole in the
  sequence. The request settles from its handler's outcome: a refusal omits it,
  and an acceptance copies `assigned` from the response into the journal line
  before any append, so a line streams complete or not at all. A request whose
  handler durably accepted (`markAccepted`) while its response was still
  pending stays unsettled until that response arrives; a handler that accepts
  with its response already known (`shadow.configure`) settles at once so it
  can flush its own request before the disable takes effect. A failure after
  acceptance keeps the request without `assigned`, and an `assigned` update
  that would push the line past the 1 MiB bound keeps the request without it
  too: the accepted input still streams, and the feeder reads a missing
  `assigned` as its unmapped-entity case instead of a replay-breaking gap.
- **Fact.** `{"fact": {"type": ..., ...}}`, carrying only fields Queue actually
  recorded. A field Queue never recorded is absent, never null and never guessed.
  | type | source | fields |
  | --- | --- | --- |
  | `worker_report` | worker or revision completion | `run`, `status`, `summary`, `head`, `pr`, `url`, `repository` |
  | `review_verdict` | reviewer completion | `run`, `head`, `status`, `summary`, `model` |
  | `pr_observed` | the PR Queue recorded | `number`, `url`, `head`, `base`, `branch`, `repository`, `remote_head`, `run`, `writer_released`, `author_models` |
  | `validation_result` | repository project validation | `head`, `base`, `argvDigest`, `exitCode`, `state` |
  | `merge_result` | `merge_verified` | `pr`, `prUrl`, `mergeCommit`, `outcome` |
  | `sync_result` | `main_synchronized` | `commit` |
  | `closeout_result` | the outcome row, or an agent closeout run | `run`, `authority`, `commit`, `outcome` |
  | `wait_state` | derived wait transition on a task, decision or prerequisite write | `task`, `state`, `owner`, `decision` only for `needs_operator_input`; source event identity distinguishes entry and exit |
  | `availability` | producer start and each observed profile/catalogue or subscription-group change | `profile`, `group`, `available`, `reason`, `retryAt`, `model`, `scopes`, `roles`, `enabled`, `byRequest`, `thinkingOptions` |
  | `merge_intent` | each recorded merge-intent state change and immediately before `merge_result` | `task`, `pr`, `head`, `base`, `requestedAt`, `responseOutcome`, `retryAt`, `retryOutcome`, `proofSince` |
  | `head_observed` | each pushed-planning capture or check, including adoption and review-entry verification | `repository`, `head`, `planningCommit`, `source` (`origin_ref` or `local_checkout`), and `ancestor` when Queue computed it; `clean` is absent for `origin_ref` and required for `local_checkout` |
  | `delivery` | `agent_created` | `run`, `agent`, `outcome` |
  | `unknown_delivery` | adoption handover marked uncertain | `attempted`, `agent`, `reason` |
  | `host_run` | Nucleus contract 010 scheduler journal, plus contract 009's `escaped_descendants_dead` fact at nucleus `e372283` | `event`, `runId`, `epoch` and recorded transition fields |
  | `host_run_authority` | Queue scheduler authority record | `holder`, `epoch`, `endpoint` |
  | `stream_gap` | a rotated gap (contract 009 at nucleus `0650526`), the new segment's line 1 | `stream` (the discarded segment file), `seq` (the gap seq), `id`, `reason`, `lostThroughSeq` (the last journalled seq discarded, when any) |

  Contract 010 host-run submissions and cancellations are captured from their
  durable journal, not the RPC dispatcher. Each submission request carries the
  recorded caller and stable `clientRequestId`; Queue stores that ID on the run
  so a re-emission after restart reuses it. The scheduler emits its authority
  fact at startup and when the holder or epoch changes. Every scheduler decision
  and fact carries its recorded `runId` and `epoch`. Decisions carry the capacity
  sample used; facts carry launch identity, classification, container reports,
  capacity release or the settlement envelope. Contract 009 at nucleus `e372283`
  defines `escaped_descendants_dead` as the proof that every recorded escaped
  process identity is gone, with `escapedDescendants` and `provenAt`; the
  following capacity release includes those same identities. The journal row ID
  is the stable shadow source identity.

  Availability snapshots read the refreshed profile catalog, each profile's
  recorded pool entry and the persisted subscription-group availability. A
  profile's `available` is false when its catalog entry is unavailable or its
  recorded group is currently unavailable. The fact includes only the
  catalogue dimensions Queue has for that profile; a missing pool entry does
  not invent roles, scopes or enabled state. A dispatch alone never emits
  an availability fact. A catalog removal is recorded as an unavailable
  profile, and a later return is a positive transition.

  `merge_intent` copies `task.resolution`'s reviewed PR number, merge head and
  base, request time and response outcome. It is emitted on the initial intent,
  recorded response/proof/retry changes, and again immediately before the
  corresponding `merge_result`, so its optional retry and proof fields reflect
  the latest Queue record available at that result.

  An initial worker's verified PR is observed twice: once when the completion
  arrives (with only the fields recorded then) and again at `workspace_released`,
  the event that records the engine's PR verification and the completion's
  release. The later fact carries `url`, `head`, `remote_head` and `repository`;
  both are truthful for their own moment. A revision's PR is observed once, at
  the `resolution` event that records the engine-verified new head after the run
  released — never at its completion, when the new head is unverified and the run
  unreleased. The revision fact therefore carries the verified `head` and
  `remote_head` and the run's recorded `writer_released`.
- **Decision.** `{"decision": {"type": ..., "task": "<queue uuid>", ...}}` in
  Queue's terms: `dispatch` (run, profile, workspace, branch), `replace` (old
  run, profile, reason), `review_route` (run, profile, head), `revise` (round,
  reason), `integration_turn` (repository, order), `merge` (pr, head, commit),
  `closeout` (authority, commit, outcome, from the outcome row's recorded
  closeout), `hold` (reason), `escalate` (reason) and `outcome` (outcome,
  reason), `stage_advance` (stage, next stage, frozen subject, verdict IDs and
  run), `stage_invalidate` (from stage, reason and frozen subject), and
  `host_run` (run ID, epoch, admission decision and capacity
  sample). A read-model decision with a `rpc` observation is not produced yet;
  the feeder's translation is the contract's owner for it.
- **Redaction.** Every emitted body is built from the named fields above; the
  serialized line is then passed through redaction. A credential-, token-,
  secret-, password-, bearer-, cookie- or key-named field is dropped whole, and
  GitHub/OpenAI/Slack token shapes plus any host-supplied literal secret are
  replaced with `[redacted]`. Credentials are never written to the stream.
- **Gaps** (contract 009 at nucleus `0650526`). A gap rotates instead of
  halting. A durable gap is recorded against its segment (file, seq, id,
  reason) and that segment closes; rotation follows at once with a seed taken
  atomically at that moment, after the unwritable event has taken effect in
  Queue. The new segment's line 1 is
  `{"fact":{"type":"stream_gap","stream":"stream-NNNN.jsonl","seq":<gap seq>,"id":<id>,"reason":<reason>,"lostThroughSeq":<last journalled seq discarded, when any>}}`.
  The discarded range — journalled but unwritten lines from after the gap up
  to the rotation point — is carried by `lostThroughSeq`, never renumbered or
  replayed into the new segment, because the seed already contains its effects.
  A gap never halts the producer: a gap in a closed segment is history, and
  `shadow.status` `halted` reads only a gap still in the current file (an
  unrecovered halt from an earlier build, which rotates at once on startup).
  An append failure and an oversized line both rotate this way.
- **Splitting.** A file holds at most 10,000 events, 16 MiB, 500 decisions and
  1 MiB per line (contract 009 at nucleus `0650526`, matching contract 010's
  request-line maximum). Reaching a total or decision bound opens the next file, whose
  sequence restarts at 1; the files are independent streams. A single line over
  1 MiB cannot be represented truthfully, so it is a durable gap and rotates: no line is
  written for it in the old segment, and the new segment opens with the `stream_gap` fact.
- **Seed per segment** (contract 009, Nucleus `533cb4b67a79c984ae8cb9c490b286910a184c99`, boundary at nucleus `0650526`).
  Each rotation captures a `nucleus.records` v1 export from the same SQLite
  transaction as the rotation point, then writes it under
  `shadow-seeds/<segment>-<ISO time>/` with `manifest.json` and
  `shadow-boundary.json`. Every rotation seed's boundary names the new segment
  with `seq: 0` (for example `{stream: "stream-0005.jsonl", seq: 0}`), so the
  feeder replays the new segment from line 1. The export uses mode 0700 for directories and 0600
  for files; the producer keeps the latest 14 seed directories. File writing is
  deferred until the transaction commits, so an export failure is recorded in
  the durable producer seed fact and `shadow.status` without stopping rotation
  or failing a Queue request. `shadow.status` exposes the latest seed path,
  manifest SHA-256, boundary and segment; the latest failed export remains visible
  even after a later seed succeeds. No portable kind or field is added.
- **Not produced yet.** Verification and recovery run completions (no fact type
  names them) and reviewer replacement (the `role_replacement` event names the
  profile but not both runs) stay out until a Queue source and a contract type
  exist. They are absent, not guessed.

## Field provenance for the Nucleus proof inventory

Evidence 016's `proof_unavailable_in_shadow` inventory names the proof fields
Nucleus could not fill. Queue closes the ones it durably records and leaves the
rest absent. `worker_run_mapping`, `review_run_mapping` and `task_mapping` are
the feeder's translation of the fact's Queue identities (`run`, `task`), not
Queue fields.

| Inventory field | Queue source or absence |
| --- | --- |
| PR `run` | the completing run (`completion.runId`, or the released revision run whose `resolution` event records the verified head) — `pr_observed.run` |
| PR `repository` | `task.repository`, else `task.repoPath` — `pr_observed.repository` |
| PR `remote_head` | `task.prHead`, the PR head Queue verified — `pr_observed.remote_head` |
| PR `writer_released` | the completing run's recorded `released` flag (`pr_observed.writer_released`), read for a revision at the `resolution` event that follows its release; the initial worker is not a run row, so no release flag is recorded for it |
| PR `author_models` | Queue's recorded author models: the worker models it observed (`workerModels`, `workerModel`, the dispatch profile's model) and a review entry's declared `authorDeclaration.models` — `pr_observed.author_models` |
| PR `url`, `head`, `number`, `base`, `branch` | `task.prUrl`, `task.prHead`, the recorded PR number and the task's base and branch |
| PR `local_head` | not recorded by Queue: it records the run's reported head on `worker_report.head` and `review_verdict.head`, never an observed worktree HEAD |
| PR `clean` | not recorded by Queue |
| PR `open`, `draft` | not recorded by Queue: the verification refuses a closed or draft PR but persists no state |
| merge intent | the reviewed PR number and `resolution.mergeHead`, `mergeBase`, `mergeRequestedAt`, `mergeResponseOutcome`, `mergeRetryAt`, `mergeRetryOutcome` and `mergeProofSince` — `merge_intent`; no Nucleus intent identity is recorded |
| merge `absence_proven` | not recorded by Queue |
| sync `merge_in_history` | not recorded by Queue: `syncMain` proves it and records only `syncedCommit` |
| closeout `intent`, `obligation`, `result`, `evidence`, `reconciled` | not recorded by Queue: Nucleus recording-plane effect fields; Queue's `closeout_result` carries `authority`, `commit` and `outcome` instead |
| pushed-head `source`, `ancestor`, `clean` | `origin_ref` identifies a fetched `origin/<base>` observation and carries no `clean`; `local_checkout` identifies committed handoff capture and carries its path cleanliness result. `ancestor` appears only when Queue computed it (never `null`). Adoption deliberately does not check cleanliness because it preserves active worker edits |
| `recording_plane_delivery` | not Queue's to record: the Nucleus recording plane's own delivery identity |
| `active_workflow_context` | supplied by the feeder's replay: the `queue.task` request carries its `taskId` |

Every "not recorded by Queue" row above is a field that would need a new Queue
domain record or write, so it stays absent under this task's observation-only
constraint and belongs to a separate recording decision. The `head_observed`
fields added here come only from existing captures and checks; no Queue domain
record is added.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | A stream file parses | Contiguous `seq`, ISO-ms UTC `at` that never decreases, unique `id`, `"v": 2`, only the contract fields (`observedAt` only on a clamped line) |
| 2 | Submission, dispatch, review, merge and closeout | Each flow contributes its request, fact and decision types |
| 3 | An operator pause | Recorded as a `queue.control` request with the recorded value |
| 4 | A planted token | Never appears; a credential-named field is dropped and the marker is visible |
| 5 | A failed append | A durable gap with the reason, the segment closes and rotation follows at once: the new segment's line 1 is `stream_gap`, the seed boundary names the new segment with `seq: 0`, and appends continue; a gap never halts the producer |
| 6 | Reaching a size bound | The next file starts at `seq` 1; a line over 1 MiB is a gap and rotates, never truncated |
| 7 | The same fixture with the stream on and off | Identical durable Queue state |
| 8 | A fresh host | Producer off, nothing written, no directory created; the setting enables it |
| 9 | A verified worker PR | `pr_observed` carries the recorded `url`, `head`, `remote_head`, `repository`, `run` and `author_models`; `local_head`, `clean`, `open`, `draft` and the initial worker's `writer_released` are absent, never defaulted |
| 10 | A merge, sync and closeout | Each fact carries only the fields Queue recorded (`outcome`/`mergeCommit`, `commit`, `authority`/`commit`/`outcome`); `intent`, `absence_proven`, `merge_in_history`, `obligation` and `reconciled` stay absent |
| 11 | A revision that moves the PR head | The PR fact is observed at the `resolution` event that records the verified head, after the run released; it names the revision run, `head`/`remote_head` are the verified head, `writer_released` is `true`, and no fact pairs the revision run with the pre-revision head |
| 12 | One mutating RPC from each catalogue group (admission, planning, lane/plan, project/repository, decision, task control) | A `request` line with the method and its full input, in acceptance order, with credentials redacted |
| 13 | A read-only method, and a mutating method whose handler refuses | No accepted `request` line, and the accepted requests keep a contiguous sequence |
| 14 | A method with no mutating/read-only classification, or a changed classification | The catalogue-completeness test fails until the method is classified deliberately |
| 15 | A `{backpressured: true}` result from `queue.submit`, `queue.task`, `queue.handoff` or `queue.operation-start` | The request is omitted like any other refusal; Queue accepted no operation |
| 16 | `records.import`, `lead.import` or `papercut.import` | A `request` line, because the method mutates Queue records; `records.export` stays absent |
| 17 | A crash between a request's journal row and its sequence counters | The journal row and counters commit together; on restart the leftover provisional row is promoted and the sequence counter is reconciled, so the next request is not dropped |
| 18 | `queue.submit` or an external-effect `queue.task` whose operation is durably accepted and then fails | The request is kept in acceptance order without `assigned`; the later failure is not recorded as a refusal |
| 19 | `shadow.configure` that disables the stream | Its request is settled and flushed before the disable takes effect, so a disabled producer writes nothing new but the accepted toggle is recorded |
| 20 | A `shadow.configure` disable whose pre-disable flush faults | The RPC returns its status, the disabling setting still applies, and the settled request stays journaled for the next enabled flush |
| 21 | `lead.add` → `lead.approve` → `lead.promote-task` | Each request carries exactly the identities its accepted response returned: the record's `id`, `version` and `digest`, then the promotion's `taskId` and `reference`, verbatim |
| 22 | A response that assigns nothing, and a refused request | The accepted request omits `assigned` whole, and the refusal leaves no line at all |
| 23 | `lead.check` → `lead.approve` → `lead.promote-task` | Each fetched planning head is a sparse `head_observed` fact with `source: "origin_ref"` and no `clean`, before the requests that rely on it; promotion records its own recheck before its request |
| 24 | A dirty brief submission checkout | `head_observed` records the fetched head with `source: "origin_ref"` and no `clean` before the submission refusal; an uncomputed `ancestor` field is absent |
| 25 | Handoff or brief submission captures planning | A fetched head carries `source: "origin_ref"` and no `clean`; a committed handoff capture carries `source: "local_checkout"` and its computed `clean` result |
| 26 | A head capture that does not compute ancestry | `ancestor` is absent from the serialized fact, never `null` |
| 27 | Adoption or review-entry verifies a planning head | Each observed head is emitted with `source: "origin_ref"`, its repository and planning commit; ancestry appears only when computed and `clean` is absent |
| 28 | Handoff capture accepts or refuses a committed handoff | The fact carries `source: "local_checkout"` and the path cleanliness result: `clean: true` on acceptance and `clean: false` before refusal |
| 29 | A segment rotates | A seed export contains the Queue records from the same atomic snapshot; its manifest and boundary sidecar are present and the boundary names the new segment with `seq: 0` |
| 30 | A seed export fails | Rotation and the Queue request succeed; the producer records the error and `shadow.status` exposes it |
| 31 | More than 14 seed exports complete | Only the latest 14 seed directories remain |
| 32 | Producer start and profile refresh | One `availability` fact per catalog profile, including its recorded catalogue dimensions; a positive or negative observed change emits one fact for that profile |
| 33 | A dispatch without an availability change | No `availability` fact is inferred from the dispatch |
| 34 | A merge intent, uncertain response, proof and retry | `merge_intent` copies the task's recorded merge fields, including retry fields when present, and precedes the `merge_result` it explains |

## Validation

The Spec 034 QA guard is `test/fixtures/contract-009-stream.json` and the
contract-first test in `test/shadow-stream.test.ts`. It pins each line kind,
fact type/event, decision type/event, request method and emitted field path to
contracts 009 and 010, including profile availability and `merge_intent` at
contract 009 `2a1634b3e2f1c8d103f24d47eaa585ed24b8f08b`, and the stage decisions
and `wait_state` at `4a3ec1b4628a2a1e9cb390a72a9c860b93bc258f`. The guard pins
the `wait_state.state` and `stage_invalidate.reason` enum values too. It writes
entry and exit facts for all wait states, plus stage advancement and both
invalidation reasons. A new type, event or path must land in the owning Nucleus
contract before the allowlist and its contract SHA change.

The producer is proved by `test/shadow-stream.test.ts`. It drives a real engine
dispatch and a real worker completion whose PR the engine verifies, a real
review → revision flow whose PR fact must appear only after the engine verifies
the new head and releases the revision run, and the engine's own durable funnels
for merge and closeout, then parses the produced file with the local version-2
validator. The PR tests assert each newly emitted field against its Queue record
and assert that a field Queue never recorded is absent rather than defaulted. The
request tests call the real `callCatalogueMethod` dispatch point: one mutating
method from each catalogue group, the mutating record imports, a read-only method
that produces none, a refused handler and a `{backpressured: true}` result that
produce no accepted event, all in acceptance order and with redaction. The
`assigned` tests drive `lead.add` → `lead.approve` → `lead.promote-task` and
assert each request carries exactly the identities its accepted response
returned, that a response with no identity omits the field whole, that a
refusal leaves no line, and that a submission whose handler durably accepted
settles from its response with the task identities. A
durable-acceptance case keeps the request when the accepted operation later
fails, and a real-runtime case proves `queue.submit` reaches that path. A
crash-recovery case proves a leftover provisional row and a lagging sequence
counter do not drop the next request. Head-proof cases assert that facts precede
their dependent requests, fetched-ref observations carry `source: "origin_ref"`
without `clean`, committed handoff capture carries `source: "local_checkout"`
with its cleanliness result, and an uncomputed `ancestor` is absent. Adoption,
dispatch and review-entry tests cover their fetched-ref observations. `test/catalogue.test.ts` fails when a catalogue method is left
unclassified or its mutating/read-only classification changes. The
full `effigy qa` board runs on `main` at a milestone, per the operator's
per-task validation ruling (Tom, 2026-09-30).


Receipt timestamp lookup during host-run replay uses the additive
`shadow_stream_at` covering index. The 2026-10-07 startup diagnosis reproduced
repeated full-journal `MAX(at)` scans before service readiness with 45,248 stored
shadow rows. Indexing that lookup preserves journal rows, sequence allocation,
replay identities and settings; startup must not depend on scanning every shadow
payload for every replayed receipt.
