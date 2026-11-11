# Host run scheduling (contract 010, imported)

Status: active until the R2 cutover ([vision](../vision.md#simplification-rulings-2026-10-31))
Imported: 2026-11-02 from nucleus `16fcb59` `docs/knowledge/contracts/010-host-run-scheduling.md`, when Tom retired the Nucleus repository. Nucleus implements this contract for Effigy v0.14 clients (`core/host-runs/host-run-*.ts`, [Spec 035](../specs/035-host-run-scheduler.md)); the historical text below is unchanged: “Queue” names this product before its rename, and “Nucleus” names the separate retired system.

---


Status: agreed between the Nucleus and Queue Chatterboxes, 2026-09-30. Queue
implements it first; Nucleus shadows it and takes it over at cutover
(contract 007 (Nucleus contract, not imported)). One open ruling is listed at the
end.

Tom (2026-09-30, Queue Spec 031): "The QA lease we added to Effigy should have
been a Queue feature - Effigy should be the runtime that executes QA, Queue and
Nucleus should manage who runs what when."

Why: Effigy's admission leases and the processes they covered had different
owners. When Queue killed a timed-out milestone run, its Effigy lease stayed
`stale_owner_unknown` with 9 CPU and 64 GiB reserved and blocked every heavy run
behind it. Neither system could prove or clean up the other's state. Under this
contract, whoever admits a run also launches it and owns its process.

## Roles

- **Scheduler:** admits, orders, launches, stops and settles host runs. Queue
  or `nucleusd`, never both at once (see Authority).
- **Supervisor:** the process the scheduler launches for each run. It starts
  the command, forwards signals and writes the result record. Any conforming
  implementation qualifies: Queue's, Nucleus's or one Effigy provides.
- **Effigy:** the runtime that executes selectors, and a thin client that
  submits heavy runs to the scheduler. It keeps no admission state.

## Authority

A host-level authority record holds `{ holder, endpoint, epoch }`. Only the
holder at the current epoch may admit or launch. Every run record carries the
epoch it was admitted under. A scheduler refuses every call that names a stale
epoch, and an old holder whose epoch has been superseded stops admitting even
if its process survives.

Handover is one step. The outgoing holder drains its live runs or hands them
over by pgid and start identity, then the epoch is bumped. There is never a
moment with two admitting holders. During the shadow run Queue holds authority
and Nucleus launches nothing; it replays Queue's scheduler events and compares
its own admission and settlement decisions.

## Submission

A caller submits:

- caller identity, and the parent run token when nested (see Heavy and light
  runs);
- repository and selector or argv;
- budget `{ cpu, memoryBytes }` as a first-run fallback only;
- priority class: `milestone`, `validation` or `interactive`;
- a deadline.

The scheduler assigns a fresh run ID to every new submission. The exact wire
shape, idempotency and ambiguity rules are in [Client protocol v1](#client-protocol-v1).

## Lifecycle

`queued → admitted → running → settled`. Settled outcomes are `passed`,
`failed`, `timed_out`, `cancelled` and `lost`. `capacity_timeout` settles a
queued run whose deadline passed before admission; it is not a failure of the
work.

Timeout and cancel send SIGTERM to the run's process group, wait the declared
grace period, then send SIGKILL. A client that disconnects from an attached run
cancels it by default.

After a scheduler restart, each unsettled run is re-attached by pgid and start
identity. A run whose group is gone settles from its result record. It settles
`lost` only when the group is proven dead and there is no result record. A lost
or timed-out run is never retried automatically: unknown outcome does not
authorize a blind retry.

## Supervisor

The supervisor puts the command in a new process group, records the pgid and a
[start identity](#start-identity), and forwards SIGTERM and SIGKILL
to the group. When the command ends it writes a durable result record
atomically (write, fsync, rename) beside the run:

```json
{ "format": "host.run.result", "version": 1, "runId": "...", "epoch": 3,
  "pgid": 4242, "startIdentity": "4242@2026-09-30T07:14:26Z",
  "exitCode": 1, "signal": null, "startedAt": "...", "endedAt": "...",
  "wallMs": 0, "cpuMs": 0, "escapedDescendants": [] }
```

Exactly one of `exitCode` and `signal` is non-null. Because the record outlives
both the supervisor and the scheduler, a restart settles finished runs by what
actually happened.

### Start identity

A start identity is `<pid>@<basis>`, compared only as an exact string, never
parsed or re-derived.

- **macOS:** the basis is the kernel process start time
  (`kinfo_proc.kp_proc.p_starttime`), truncated to whole seconds and written
  in UTC as `YYYY-MM-DDTHH:MM:SSZ`, with no fractional part. Rust reads
  `p_starttime.tv_sec` through `sysctl`. A producer without `sysctl` (Node)
  runs `ps -o lstart= -p <pid>` with `LC_ALL=C` and `TZ=UTC`, and parses the
  C-locale form `%a %b %e %H:%M:%S %Y` as UTC. Both give the same second.
- **Linux:** the basis is `<boot_id>:<starttime>`. `boot_id` is
  `/proc/sys/kernel/random/boot_id`. `starttime` is field 22 of
  `/proc/<pid>/stat`, in clock ticks since boot, as a decimal integer, parsed
  after the last `)` so that command names containing spaces or parentheses
  are safe. The boot ID is there because ticks restart at boot, so a reused PID
  after a reboot could otherwise repeat an identity. There is no `ps`
  fallback.
- **Unknown:** if the basis can't be read, the identity is `<pid>@unknown`. It
  never proves identity: any comparison involving it is false, including
  against itself, and settlement treats it as not proven.
- **Legacy:** until every producer emits the canonical form, a reader may
  treat `<pid>@YYYY-MM-DDTHH:MM:SS.000Z` as equal to
  `<pid>@YYYY-MM-DDTHH:MM:SSZ`, for whole-second macOS values only. Any other
  fractional value refuses proof. Producers emit only the canonical form.

Whole-second resolution on macOS leaves PID reuse within the same second
undetected. That's accepted: the kernel doesn't reuse a PID that quickly
under normal load.

Cross-language test vectors:

1. macOS: C-locale UTC `ps` output `Thu Oct  1 13:01:39 2026` for pid 4242
   gives `4242@2026-10-01T13:01:39Z`. The same process read with
   `TZ=America/Los_Angeles` and `LC_ALL=de_DE` in the caller's environment
   still gives `4242@2026-10-01T13:01:39Z`, because producers force C and UTC.
2. Linux: boot ID `0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0` and stat line
   `4242 (sh) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 ...`
   give `4242@0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:987654`. The command name
   `(a) b)` parses from the last `)`.
3. Unreadable `/proc` gives `4242@unknown`, and `4242@unknown` is not equal to
   `4242@unknown`.
4. Legacy: `4242@2026-10-01T13:01:39.000Z` equals
   `4242@2026-10-01T13:01:39Z`. `4242@2026-10-01T13:01:39.500Z` refuses proof
   against `4242@2026-10-01T13:01:39Z`. `4242@unknown` refuses proof against
   any value.

(Queue and Effigy Chatterboxes, planner amendment adding the Linux boot ID,
2026-10-01.)

Every run settles with a settlement envelope, whether it launched or not:

```json
{ "format": "host.run.settlement", "version": 1, "runId": "...",
  "outcome": "failed", "launched": true, "settledAt": "...",
  "result": { "format": "host.run.result", "...": "..." },
  "containers": [] }
```

- `launched: false` is only for `cancelled` and `capacity_timeout` runs that
  never started. They have no `result`, pgid or start identity.
- `launched: true` carries `result` for every outcome except `lost`, which by
  definition has no result record.
- `containers` is the container closure evidence below.

`attach`, `status` and the shadow `settled` fact all carry the envelope.

Stopping is best effort. A descendant that calls `setsid` leaves the group, and
test servers do this. A group counts as proven dead only when it is empty and
no escaped descendant it knows about is alive. Escapes the supervisor sees are
recorded as facts, so a leaked server stays visible instead of silently holding
capacity.

An empty group proves only that host processes are gone. Containers started
through a container daemon (nerdctl, colima, docker) run outside the group and
can outlive it; on 2026-09-30 task d8b9b168's containers did. The runtime that
starts a container (Effigy) reports its runtime and container ID as a fact.
The settlement lists each one as `{ runtime, id, removed: true | false | "unknown" }`.
A run's capacity stays reserved while any of its containers is `false` or
`"unknown"`, until the runtime reports it removed or an operator releases it,
and the release is recorded as a fact. Nothing about containers is inferred
from the process group.

## Heavy and light runs

The repository classifies its selectors as heavy or light in its Effigy
manifest, with a scheduler-side default list for repositories that don't. The
scheduler launches every heavy run, including a worker's or planner's own
out-of-band `effigy` call. The Effigy client submits, then attaches to output
and exit over the scheduler endpoint, so the caller still sees normal streaming
output. The client reports the classification it resolved as a fact.

The scheduler passes a run token in the environment. An `effigy` invoked inside
an admitted run inherits the parent's class and budget instead of requesting
admission again, which prevents a run waiting on itself.

Light runs execute directly. When the scheduler is unreachable, heavy runs
fail closed with a clear error and light runs still execute. An operator may
override; the override is recorded as a fact (Tom, 2026-09-30, relayed by the
Queue Chatterbox). Why: an unmanaged fallback recreates the oversubscription
this contract exists to prevent. The cost is that a scheduler outage blocks
full QA until it is back.

## Client protocol v1

Queue and `nucleusd` serve this protocol, and the Effigy client speaks it. Trust
is the host user: every party runs as the same uid. `caller` attributes a run;
it does not authenticate it.

### Discovery

The holder writes `~/.local/state/host-run/authority.json` atomically, mode
0600:

```json
{ "format": "host.run.authority", "version": 1, "holder": "queue",
  "endpoint": "<home>/.local/state/host-run/run/scheduler.sock",
  "epoch": 3, "pid": 4242, "startIdentity": "4242@2026-09-30T07:14:26Z" }
```

File ownership, modes and path checks are in [Files](#files). Before any call
the client also checks that the socket's owner is its own uid, and that the
peer's PID (`LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux) and that
process's start time match `pid` and `startIdentity`. `getpeereid` alone gives only the uid. If any check fails,
the scheduler is unreachable.

### Transport

Newline-delimited JSON over the socket, one object per line, at most 1 MiB.
Requests are `{ v: 1, id, method, epoch, body }`, where `epoch` is the value the
client read from the authority file. Responses are
`{ v: 1, id, ok: true, body }` or `{ v: 1, id, ok: false, error: { code, message } }`.

| Code | Meaning | Client action |
| --- | --- | --- |
| `unsupported_version` | Unknown `v` | Treat as unreachable |
| `stale_epoch` | Request epoch isn't current | Re-read the authority file, reconnect, recover by `status` |
| `unknown_run` | No such run or request | See submit ambiguity |
| `conflict` | Same `clientRequestId` with a different body | Fix the client; never retry |
| `not_permitted` | The class or method isn't allowed for this caller | Report and stop |
| `invalid` | The body fails validation | Report and stop |

Two outcomes are client-side exit codes rather than wire errors: 75
`scheduler_unreachable` and 77 `invalid_parent_token`.

`capacity_timeout` isn't an error. It is a settled outcome and arrives as a
settlement.

### Methods

**`submit`** body:

```json
{ "clientRequestId": "uuid", "caller": "effigy@worker-7", "repository": "owner/name",
  "cwd": "/abs/worktree", "selector": "qa:core", "argv": ["effigy", "qa:core"],
  "class": "heavy", "classSource": "manifest", "priority": "interactive",
  "budgetFallback": { "cpu": 4, "memoryBytes": 8589934592 },
  "capacityDeadlineMs": 1800000, "runTimeoutMs": 3600000,
  "env": { "NAME": "value" }, "cancelOnDisconnect": true }
```

It returns `{ runId, state: "queued" | "admitted", position? }`.

- `priority` is `interactive`, `validation` or `milestone`.
- `classSource` is `manifest` or `default`.
- `cancelOnDisconnect` defaults to true for `interactive` and false otherwise.
- `capacityDeadlineMs` counts from submit and `runTimeoutMs` from launch. Both
  are required and stored separately.
- Budgets are keyed by `(repository, selector)`. `argv` is what runs, in `cwd`,
  with only the listed `env` plus `PATH`, `HOME`, `HOST_RUN_ID` and
  `HOST_RUN_TOKEN`.

Submit is idempotent on `(caller, clientRequestId)`: the same pair returns the
existing run and never creates a second one. The scheduler keeps the key for
at least 24 hours after settlement. If the connection drops before a reply, the
client calls `status` with `{ caller, clientRequestId }`. It may resubmit, with
the same `clientRequestId`, only after `unknown_run`. It never resubmits blind.

**`attach`** body: `{ runId, fromOffset?: { stdout, stderr } }`. The server
streams, one response line each:

- `{ event: "state", state, position? }`
- `{ event: "output", stream: "stdout" | "stderr", offset, dataB64 }`, in
  chunks of at most 64 KiB;
- `{ event: "output_expired", stream, availableFrom }` (see below);
- `{ event: "settled", settlement }`, last, carrying the
  [settlement envelope](#supervisor).

Offsets are bytes per stream. While output is retained, a reattach resumes
with no gaps or duplicates. Output is kept until an hour after settlement. If
`fromOffset` asks for bytes that are gone, the first event for that stream is
`{ event: "output_expired", stream, availableFrom }`, and streaming continues
from `availableFrom`. The settlement is still delivered. If the socket closes
before settlement and the run has `cancelOnDisconnect`, the scheduler cancels it
after a 5-second reconnect window. A reattach inside that window keeps the run.

**`cancel`** body: `{ runId, reason }`. It returns once the stop path has
started, and is idempotent. The settlement arrives through `attach` or
`status`.

**`status`** body: `{ runId }`, `{ caller, clientRequestId }` or `{}`. It
returns the run record (state, position, both deadlines, epoch, pgid, and the
settlement envelope once settled), or for `{}` a host summary (budget, running, queued).

**`report`** body: `{ facts: [...] }`. It records facts the client observed
and admits nothing. Every fact carries a client-generated UUID `factId` and an
`observedAt` time. The shapes are:

- nested run: `{ kind: "nested", factId, observedAt, parentRunId, selector }`;
- operator override: `{ kind: "override", factId, observedAt, reason, selector }`;
- container: `{ kind: "container", factId, observedAt, runId, epoch, runtime, containerId, event: "started" | "removed", removed? }`.
  `removed` is required on `removed` events and is `true`, `false` or
  `"unknown"`: whether the removal succeeded.

`report` is durable and idempotent. The server stores each fact before it
replies, dedups on `factId`, and acks every fact with its stored copy. A known
`factId` with a different body is `conflict`. The client keeps each fact in
`pending-facts.jsonl` and replays it, at least once, until the fact is acked.
A duplicate changes nothing, so it never double-counts capacity.

For each `(runId, runtime, containerId)`, `started` opens the container against
the run's capacity. A `removed` event with `removed: true` settles it: capacity
can be released and nothing reopens it, including a later or replayed
`started`. `removed: false` or `"unknown"` leaves it open. The shadow stream
carries the stored facts.

### Run token

`HOST_RUN_TOKEN` is `<payload>.<mac>`:

- `payload` is the UTF-8 JSON claims object, encoded as RFC 4648 §5
  base64url **without padding**.
- `mac` is `HMAC-SHA256(key, payload)` over the ASCII bytes of `payload` as
  transmitted, encoded the same way. Readers verify the MAC over the received
  first part, so producers may serialize the JSON in any key order.
- The claims are exactly `{ runId, epoch, class, root, exp }`, and readers
  refuse any other field. `runId` is a string of 1 to 160 characters,
  `epoch` a positive integer, `class` is `"heavy"` or `"light"`, and `root`
  is the run's canonical `cwd` as a non-empty string.
- `exp` is an integer number of milliseconds since the Unix epoch, UTC: launch
  time plus `runTimeoutMs` plus the grace period. It is not seconds and not
  RFC 3339. A token is unexpired while `now_ms < exp`.

Keys are in `token.key` (see Files). The key rotates at each epoch bump.

Test vectors (checked against Queue's signer at 7563a61):

1. Key bytes `0x00` to `0x1f` give `keyB64`
   `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=`.
2. Claims serialized as
   `{"runId":"run_0001","epoch":3,"class":"heavy","root":"<home>/worktrees/task-1","exp":1790866800000}`
   (that `exp` is 2026-10-01T15:00:00.000Z) give the token
   `eyJydW5JZCI6InJ1bl8wMDAxIiwiZXBvY2giOjMsImNsYXNzIjoiaGVhdnkiLCJyb290IjoiL1VzZXJzL2Rldi93b3JrdHJlZXMvdGFzay0xIiwiZXhwIjoxNzkwODY2ODAwMDAwfQ.1LRaMZwc4Y4--VvTdOLvsBRkY85JgHvk8YyyS1GZ8Ek`.
3. Expiry: that token is valid at `now_ms` 1790866799999 and expired at
   1790866800000.

A token is valid when all of these hold:

- `exp` hasn't passed;
- the client's canonical `cwd` equals `root` or is below it;
- either the token's epoch equals the authority file's epoch and its MAC
  verifies under the `current` key;
- or the token's epoch is exactly one less, its MAC verifies under the
  `previous` key with that epoch, and `status { runId }` shows the run running
  and taken over by the current holder. If the scheduler is unreachable for
  this lookup, a heavy nested run exits as unreachable.

A valid token runs the selector directly without admission, never submits, and
reports a `nested` fact. If `HOST_RUN_TOKEN` is set but the token isn't valid,
the client is inside a parent it can't verify. It exits 77 with
`invalid_parent_token` and never submits or queues, because a normal submit
would wait on its own parent. Only an unset `HOST_RUN_TOKEN` leads to a normal
submit. Tokens don't cross `sudo` or container boundaries.

### Files

Everything lives under `~/.local/state/host-run/`, owned by the host uid and
mode 0700. That includes `run/` for the socket and `runs/<runId>/` for each
run's result record, output and settlement.

| File | Mode | Written by |
| --- | --- | --- |
| `authority.json` | 0600 | The holder |
| `token.key` | 0600 | The holder, at each epoch bump |
| `run/scheduler.sock` | 0600 | The holder |
| `runs/<runId>/*` | 0600 | The supervisor and the scheduler |
| `pending-facts.jsonl` | 0600 | The client |

`token.key` is JSON: `{ format: "host.run.keys", version: 1, current: { epoch, keyB64 }, previous?: { epoch, keyB64 } }`,
with 32 random bytes per key. `keyB64` is RFC 4648 §4 standard base64 with
`=` padding, so exactly 44 characters. Readers refuse a value that doesn't
decode to exactly 32 bytes, and don't accept base64url or unpadded forms.

Writers write to a temporary file in the same directory, fsync it, then rename
it over the target.

The strict checks apply only to the owned subtree, `~/.local/state/host-run/`
and everything under it: owner is the uid, directories are 0700, files are 0600
and nothing is a symlink. Ancestors such as `/`, `/Users` and `~/.local` are
not checked for mode or owner. Instead:

1. Resolve the subtree root once with `realpath`, open it with
   `O_DIRECTORY | O_NOFOLLOW`, and `fstat` the handle for owner and 0700.
2. Open everything beneath it relative to that handle, one component at a time,
   with `openat` and `O_NOFOLLOW` (plus `O_DIRECTORY` for directories). `fstat`
   each handle for type, owner and mode. An ancestor swapped after step 1 can't
   redirect a read.
3. Check the socket with `fstatat(..., AT_SYMLINK_NOFOLLOW)` relative to the
   `run/` handle: it must be a socket with the uid as owner and mode 0600.

An implementation without descriptor-relative open (Node, for example) uses
verified traversal instead. The wire is unchanged:

1. Resolve the subtree root once with `realpath`.
2. `lstat` every component from the root to the target, applying the strict
   checks above, and record each `(dev, ino)`.
3. Open the target with `O_NOFOLLOW` (plus `O_DIRECTORY` for a directory),
   `fstat` it, and require the target's recorded `(dev, ino)`.
4. `lstat` the root and every ancestor again, requiring the same `(dev, ino)`
   and the same checks.

Any difference refuses, as a swapped component. `O_NOFOLLOW` protects only the
final component, so step 4 is what refuses an ancestor swapped at any point
between steps 2 and 4. The socket is checked the same way, immediately before
`connect` (client) or after `bind` (server).

The residual risk is an ancestor swapped and swapped back within one open (an
ABA swap). Only `openat` can prevent it. That is accepted: only a same-uid
process can make the swap, and such a process is inside the trust boundary and
can write these files directly anyway. A helper process providing real
`openat` was considered and declined, because it adds a runtime dependency
for no gain inside that boundary (Queue and Effigy Chatterboxes, planner
ruling, 2026-10-01).

Paths outside the subtree, a token's `root` and the client's `cwd`, are
compared only after `realpath`. A failed check means unreachable, or
`invalid_parent_token` for the token's paths.

### Unreachable

A heavy run exits with code 75 (`EX_TEMPFAIL`) and prints
`scheduler_unreachable`. A light run executes. `EFFIGY_SCHEDULER_OVERRIDE=<reason>`
runs a heavy selector anyway. The client appends the override to a pending-facts
file (`~/.local/state/host-run/pending-facts.jsonl`, mode 0600) and flushes it
through `report` on its next reachable call.

## Capacity and fairness

The scheduler admits against a measured host budget with headroom. A run's
budget is the measured cost for its selector, for example p95 from the Spec 031
telemetry (queue wait, wall time, CPU). The caller's value applies only until a
measurement exists, so under-declaring can't oversubscribe the host. Order is
`milestone > validation > interactive`, with aging so interactive runs can't
starve, and fairness per repository.

## Durability and shadow events

The scheduler's journal is the source of truth. A Queue scheduler emits into
the shadow stream (Nucleus contract, not imported):

- `request`: each submit and cancel, with its full input;
- `decision`: each admit, reject and queue position, with the capacity sample
  it used, so a replay reproduces the choice;
- `fact`: launched (run ID, pgid, start identity, epoch), escaped descendant,
  container started and removed, capacity release, resolved classification,
  nested run, override, and settled (the settlement envelope).

## Migration

Each step is reversible until (c):

1. (a) Queue implements this contract. Queue's milestone QA and project
   validation runs submit to it instead of taking Effigy leases. Effigy's
   lease store still exists. Nucleus shadows from here.
2. (b) The Effigy client switches to this contract behind a setting, so
   out-of-band heavy runs submit to the scheduler.
3. (c) Effigy's lease store is removed.
4. (d) Nucleus takes the authority epoch at cutover.

## Nucleus implementation

- Kernel: host-resource admission in `nucleus-core` scheduling (measured
  capacity, per-selector budgets, priority with aging, per-repository fairness,
  typed deadlines), with the authority epoch in the journal.
- A host-neutral local process execution plane in `nucleusd`, not in a host
  adapter, because BB-hosted instances need it too. It launches through a
  conforming supervisor and declares fence detected (start identity), stop best
  effort, submission lookup-before-retry (the result record).
- Scheduler methods on the `nucleusd` socket for Effigy clients: submit,
  attach, cancel and status, each checking the authority epoch.
- A shadow comparator for the scheduler event kinds.

## Service primitive maintenance

The endpoint's duplicate fact cache and `facts.jsonl` are bounded to 4 MiB and
2,000 cached facts. Startup reads only a complete tail of a legacy log and
compacts it. The durable host-run journal remains the authority for replay and
fact-body conflicts after cache eviction. Authority publication failures are
reported through endpoint health and the service log until a successful retry.
A running command without a supervisor is signalled only after its recorded
leader PID and start identity prove it is still the same process.
