# 001 - Generic repository hooks

Status: implemented
Owner: operator and Chatterbox
Created: 2026-09-12
Governing refs: `docs/knowledge/architecture.md`, `docs/knowledge/contracts/orchestration.md`, `docs/knowledge/contracts/repository-hooks.md`
Repair authority: `docs/knowledge/specs/002-durable-hook-retry-and-isolated-writes.md`
Execution: g01.007 ready; separate operator dispatch approval required
Source authority: Northstar relay `docs/handoffs/20260912-183929-queue-generic-hook-planning.md` at `795f9fc443922ddbe57e26254218fdb04b86ba4e`

## Problem

Nucleus can transport a committed Northstar handoff and can ask a coordinator to
publish Northstar closeout Markdown. Those adapters work, but the Nucleus core has
no repository-owned hook boundary. A repository cannot apply its own lifecycle,
policy, or document system without teaching Nucleus that system.

## Outcome

Nucleus discovers an optional, committed control manifest, emits generic events,
runs fixed repository programs without a shell, validates their results, and
publishes declared integration changes through a durable outbox. Repositories
may use any document or state system. Repositories without a manifest retain
current behavior byte for byte.

## Frozen v1 surface

This surface stays frozen. Spec 007 adds the separately versioned
`paseo.queue.control.v3` / `paseo.queue.event.v2` reviewed-head pre-merge
contract without reinterpreting v1 or v2 manifests and occurrences.

### Instruction artifact

The generic task input carries one immutable instruction artifact:

```json
{
  "path": "relative/path/in-repository",
  "commit": "40-lowercase-hex",
  "digest": "sha256:64-lowercase-hex",
  "mediaType": "text/markdown"
}
```

`path` is normalized repository-relative POSIX syntax, contains no empty, dot,
or parent segment, and resolves at `commit` to one regular Git blob. `digest` is
SHA-256 over the exact blob bytes. `mediaType` is an opaque lower-case type and
optional parameters, at most 200 bytes. Nucleus validates identity and retains the
bytes it dispatched; it does not parse their document grammar.

The existing Northstar handoff RPC becomes an adapter: it resolves the committed
Markdown file into this shape and keeps current task identity stable. Existing
stored `handoffPath`, `handoffText`, and `planningCommit` fields remain readable
during migration. They are removed with the legacy closeout callers after
terminal parity, not retained as a second permanent core contract.

### Control manifest

Nucleus reads `.paseo/queue.json` from the clean synchronized integration commit
selected for the event. Absence means no hooks. The file must be a regular blob,
UTF-8 JSON with no duplicate keys, at most 64 KiB, and validate exactly as
`paseo.queue.control.v1`; unknown keys fail the manifest.

```json
{
  "schema": "paseo.queue.control.v1",
  "hooks": [
    {
      "id": "repository-lifecycle",
      "events": ["task.pre_dispatch", "task.blocked", "task.cancelled", "task.closeout"],
      "mode": "read_only",
      "delivery": "required",
      "executable": ".paseo/hooks/repository-lifecycle",
      "argv": [],
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedPaths": [],
      "commitSubject": null
    }
  ]
}
```

Rules:

- `hooks` contains 0–16 entries with unique ASCII IDs matching
  `[a-z][a-z0-9-]{0,62}`. Each event appears at most once per hook.
- `events` is a non-empty subset of `task.pre_dispatch`, `task.blocked`,
  `task.cancelled`, and `task.closeout`.
- `mode` is `read_only` or `integration_write`. `task.pre_dispatch` accepts only
  `read_only`; the other events accept either mode.
- `delivery` is `required` or `advisory`. A required blocked/failed result holds
  the triggering transition. Advisory failure is recorded and may advance only
  when no repository mutation or publication outcome is uncertain.
- `executable` is a normalized repository-relative path to one regular,
  executable, non-symlink blob at the pinned manifest commit. Nucleus invokes it
  directly with `shell: false`. `argv` has at most 32 literal UTF-8 values, each
  at most 1 KiB. Event values, environment variables, and templates are never
  interpolated into either field.
- `timeoutMs` is 100–120000. `maxOutputBytes` is 1024–1048576 and applies
  independently to stdout and stderr. Limit breach terminates the process and
  records failure; partial stdout is never accepted.
- `allowedPaths` contains at most 64 normalized exact file paths or tree
  prefixes ending `/`. Entries cannot name `.git`, the manifest, hook
  executables, Nucleus state, or escape through a symlink. `read_only` requires an
  empty list.
- `integration_write` requires `commitSubject` with ASCII `prefix` of 1–50
  bytes and `maxBytes` from 20–100. The hook may request only the suffix. Nucleus
  joins prefix and suffix, rejects newline/control bytes and the size overflow,
  and creates the commit itself.

Nucleus pins `{path, commit, digest}` for the manifest and every repository-local
executable before recording event intent. A later retry uses that identity or
fails stale; it never silently consumes a newer manifest.

### Event input

The hook receives exactly one JSON object on standard input and EOF:

```json
{
  "schema": "paseo.queue.event.v1",
  "eventId": "opaque-stable-id",
  "hookId": "repository-lifecycle",
  "event": "task.closeout",
  "occurredAt": "RFC3339 timestamp",
  "attempt": 1,
  "repository": {
    "root": "/absolute/canonical/path",
    "baseBranch": "main",
    "baseCommit": "40-lowercase-hex"
  },
  "task": {
    "id": "opaque-queue-task-id",
    "title": "opaque title",
    "phase": "closing",
    "instruction": {
      "path": "relative/path/in-repository",
      "commit": "40-lowercase-hex",
      "digest": "sha256:64-lowercase-hex",
      "mediaType": "text/markdown"
    }
  },
  "delivery": {
    "prUrl": null,
    "prNumber": null,
    "head": null,
    "review": null,
    "mergeCommit": null,
    "integrationCommit": null,
    "summary": "bounded opaque text"
  }
}
```

The schema is closed. Optional delivery facts use explicit `null`; fields are
never omitted according to document type. Nucleus supplies only facts already
accepted by its own gates. `title`, paths, URLs, and summaries are data, never
command input. `eventId` is generated and persisted before execution and stays
stable across retries. `attempt` counts confirmed executions, not ambiguous
ones.

Event timing:

- `task.pre_dispatch`: after submission, dependency, capacity, clean-base,
  manifest, and instruction validation; before workspace or agent intent.
- `task.blocked`: after a durable worker or resolution blocked/error receipt is
  accepted and its lease is released. Transient attention does not emit it.
- `task.cancelled`: before a queued cancellation becomes terminal.
- `task.closeout`: after merge, synchronized integration state, accepted
  closeout evidence, and manifest pin; before Nucleus marks the task done. This is
  initially compatible with the existing closeout route and may run in shadow.

At most one active hook event may write a repository. Integration-write hooks
hold the existing repository integration turn through remote verification.

### Hook result

Stdout contains one JSON object and no other bytes:

```json
{
  "schema": "paseo.queue.hook-result.v1",
  "eventId": "opaque-stable-id",
  "outcome": "ok",
  "summary": "bounded text",
  "metadata": {},
  "changedPaths": [],
  "commitSubjectSuffix": null
}
```

`outcome` is `ok`, `blocked`, or `failed`. `summary` is 1–4000 UTF-8 bytes.
`metadata` is an opaque JSON object capped at 32 KiB and retained in Nucleus
history; Nucleus does not infer authority from it. `changedPaths` is a sorted,
unique list of normalized repository-relative paths. `commitSubjectSuffix` is
valid only for a successful integration write and is at most the remaining
manifest subject budget. Wrong schema/event ID, unknown keys, malformed JSON,
extra stdout, or invalid bounds is failure.

A read-only hook must leave HEAD, index, and non-ignored Git status
byte-identical and return no changed paths or commit subject. Git-ignored
runtime files may change, remain local, and are never staged or published. An
integration-write hook must begin on clean synchronized base, must not stage or
commit, and must return exactly the non-ignored paths shown by Nucleus's post-run
Git inspection. Nucleus rejects undeclared, missing, symlinked, special, staged,
or submodule changes and restores no bytes on failure; the repository enters
attention for bounded reconciliation.

## Execution and publication

Nucleus spawns the pinned executable in the canonical repository root with stdin,
stdout, and stderr pipes, `shell: false`, no network or sandbox claim, and a
minimal explicit environment: `PATH`, `HOME`, `TMPDIR`, `LANG`, and `LC_ALL`
when present, plus `USER` derived from the launch process's OS user identity
and non-secret `PASEO_QUEUE_EVENT_ID` and `PASEO_QUEUE_EVENT_SCHEMA`. Ambient
`USER` cannot override that identity. An unavailable OS identity refuses launch
rather than guessing a username. Project QA and task validation use this same
builder, so existing host sign-in discovery receives identity metadata without
forwarding credential variables. A new milestone QA run then overlays its
recorded run-scratch leaf as `TMPDIR`, `TMP` and `TEMP`; a run already in flight
keeps the environment it launched with. This supplies no authority to repeat a live
acceptance attempt. Callback credentials, daemon authentication, and
unrelated agent environment are absent.

For an integration write Nucleus:

1. owns the repository integration turn and verifies that the canonical base is
   on the expected branch at the exact base commit with clean tracked and
   untracked state; pre-existing ignored content is allowed and untouched;
2. records event, manifest, executable, base, isolated-checkout path and
   execution intent in SQLite before creating that Nucleus-owned checkout;
3. creates the isolated checkout at the exact base and executes once there,
   storing the complete bounded result before interpretation;
4. rechecks unchanged HEAD and validates declared and actual paths inside the
   isolated checkout;
5. records commit intent, stages only the exact allowed changed paths, creates a
   commit with Nucleus-owned event and manifest trailers, and records its SHA;
6. records push intent, pushes normally to the configured base branch, fetches,
   and verifies the remote points to that SHA;
7. fast-forwards the canonical checkout to the published commit (or to an
   accepted later remote tip that contains it), refuses a collision with
   ignored content or diverged history, and proves the canonical HEAD matches
   the remote before allowing the transition;
8. removes only the isolated checkout it created after that proof; and
9. marks the hook event published.

Nucleus never uses `git add .`, force-push, shell command construction, or hook
output as Git arguments except the validated subject suffix. A no-diff `ok`
result records success without a commit. The event's `repository.root` names the
actual execution checkout; read-only hooks keep running in the canonical
checkout.

## Durable state and recovery

Hook events live in a separate SQLite outbox keyed by `(taskId, hookId, event,
eventId)`. Each record persists the immutable occurrence payload — event ID,
original occurrence time, repository base, task and instruction identity,
delivery object, and manifest and executable pins — plus the Nucleus-owned
isolated checkout path. A retry reproduces that payload with only the confirmed
attempt advancing; it never rebuilds delivery from the current task reason.
States are `intent`, `workspace_intent`, `running`, `result`, `commit_intent`,
`committed`, `push_intent`, `sync_intent`, `synced`, `cleanup_intent`,
`published`, `blocked`, `failed`, and `uncertain`. Schema 2 upgrades
transactionally through schema 3 to schema 4; existing tasks, settings, pool,
availability, limits, pause, notices, receipts, hook identities and assignments
are unchanged. Records without a stored payload recover their delivery from
Nucleus's own task, run, review, verification, merge and closeout state when it is
unambiguous and expose that recovery in history; a missing or ambiguous fact is
rejected rather than guessed.

Identical repeated results return the stored outcome. Reusing an event ID with
different event or payload fails. After restart:

- `intent` with no process side effect may execute with the same event ID;
- `workspace_intent` returns to `intent` when the recorded Nucleus-owned checkout
  is absent or clean at the base, and raises attention otherwise;
- `running` is uncertain and requires repository/process reconciliation before
  execution can repeat; a dead process with a clean isolated checkout at the
  base returns to `intent`;
- `commit_intent`/`committed` searches local history for the exact Nucleus event
  and manifest trailers, verifies parent, tree, and allowed paths, then adopts
  the one matching commit or raises attention;
- `push_intent` fetches the remote and adopts the recorded commit only when the
  expected branch points to it or contains it through an accepted later Nucleus
  publication;
- `sync_intent`/`synced` fast-forwards the canonical checkout and refuses a
  collision with ignored content or diverged history; and
- `cleanup_intent` removes only the Nucleus-owned checkout after a terminal proof.

Divergent, ambiguous, dirty, or multiple matches stay in attention. Required
delivery cannot advance. Advisory delivery also waits while repository mutation
or publication is uncertain.

A versioned retry control may resume only a reconciled event. It cannot clear an
unknown process, commit, or push outcome. History and detail expose manifest,
base, event, attempt, bounded result, commit, push, and error identities.

## Compatibility and cutover

Manifest absence preserves current dispatch and closeout. Version 1 adds the
generic instruction identity while the Northstar submitter remains an adapter.
The existing Northstar-specific closeout prompt and allowlist remain active
until Northstar proves equivalent terminal receipts and one live shadow
closeout. Their removal is a later explicitly planned migration and must remove
callers together; no permanent dual route is allowed.

## Acceptance matrix

| Invariant | Counterexample | Required proof |
| --- | --- | --- |
| Nucleus is document-system agnostic | Core imports Northstar, parses Markdown, knows `gNN.NNN`, or embeds Northstar paths/commands | Repository-neutral schemas plus a plain JSON-ledger fixture with no Northstar dependency |
| Absence is compatible | A repository without `.paseo/queue.json` changes dispatch, closeout, task identity, or stored defaults | Existing suite and before/after serialized fixtures |
| Commands are fixed | Event content reaches executable/argv or a shell | hostile title/path/summary fixture and captured spawn arguments |
| Read-only means read-only | A gate changes, stages, commits, or moves HEAD | status/index/HEAD negatives with prior bytes preserved |
| Writes are bounded | Hook changes an undeclared, ignored, symlink, submodule, special, or staged path | changed-path matrix and exact staging proof |
| Publication is fenced | Timeout repeats a process, commit, or push blindly | restart fixtures for every outbox state and Git reconciliation |
| Required delivery gates | Required blocked/failed hook advances task | transition assertions for all four events |
| Advisory stays safe | Advisory uncertainty advances over an unknown mutation | failure may advance only with proven clean unchanged repository |
| Instruction is opaque and immutable | Nucleus parses content or accepts changed bytes at the same path | media-type fixtures, digest mismatch, changed commit, and regular-blob checks |
| Legacy route is bounded | Generic support silently removes or duplicates current closeout | no-manifest regression and shadow coexistence proof |

## Non-goals

Northstar lifecycle semantics, Markdown projection, task-number parsing, remote
webhooks, arbitrary PATH commands, secret injection, a general CI runner,
container sandboxing, hook-selected staging, force-push, and legacy closeout
removal are outside version 1.

## Stop conditions

Stop if implementation needs Northstar imports or vocabulary in Nucleus core,
passes event data through a shell, cannot prove exact changed paths, lets hooks
stage/commit/push, retries an uncertain effect without reconciliation, weakens
current task/PR/review/merge gates, edits live SQLite directly, or requires a
permanent generic-plus-Northstar closeout split.
