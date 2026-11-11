# 002 - Durable hook retry and isolated integration writes

Status: implemented; isolated integration writes to be retired (R5, 2026-10-31)
Owner: operator and Chatterbox
Created: 2026-09-12
Governing refs: `docs/knowledge/contracts/orchestration.md`, `docs/knowledge/contracts/repository-hooks.md`, `docs/knowledge/specs/001-generic-repository-hooks.md`
Execution: g01.008 and g01.014 implemented; g01.016 repair authorized by Tom on 2026-09-13

## Problem

The first live required `task.closeout` hook exposed two defects after its PR,
review, merge, and legacy closeout had succeeded.

First, Nucleus checks the operator's canonical checkout with `git status
--ignored`. Northstar has 5,756 ignored local artifacts, mainly durable Effigy
task history. The checkout is clean for Git publication, but Nucleus refuses the
hook before execution. Removing those files would destroy useful evidence.

Second, `retry_hook` rebuilds a blocked event from only its event name, base,
and current task reason. It drops the original delivery object. The retry then
sends `null` for the reviewed head, review, merge commit, and integration
commit. A repository adapter cannot produce an honest terminal receipt from
that payload.

The affected live task is Nucleus task
`b45c4f85-aa3c-46b4-920d-0bd26773faca`. Its hook record
`1a2951fb-5dbf-4768-8c57-017ca76fc106` is blocked after one confirmed adapter
execution. Its PR, independent review, merge, legacy closeout, task identity,
event ID, and stored evidence remain valid.

## Outcome

Nucleus retries a reconciled hook with the same durable event facts and a higher
confirmed-attempt count. Integration-write hooks execute from a Nucleus-owned
clean isolated checkout at the pinned base, so ignored operator artifacts never
need to be deleted, relocated, or trusted. Nucleus publishes the exact allowed
change, synchronizes the canonical integration checkout without disturbing its
ignored files, and retains the existing integration turn and uncertain-effect
gates.

After merge and plugin reload, the existing Northstar task can retry the same
hook record and complete its live shadow cutover. No replacement Nucleus task,
hook occurrence, or Northstar lifecycle task is created.

## Frozen behavior

### Retry fidelity

- Persist the immutable event occurrence facts needed to reproduce delivery:
  event ID, original occurrence time, repository base, task/instruction
  identity, delivery object, manifest and executable pins. A retry increments
  only the confirmed execution attempt.
- A retry must not rebuild delivery from the current task reason or silently
  replace a non-null fact with `null`. Event and result schemas stay v1 unless
  an additive internal persistence field is needed.
- Existing hook records migrate transactionally with all Nucleus tasks, settings,
  pools, availability, limits, pause state, runs, notices, and hook identities
  preserved.
- The one live pre-migration blocked closeout record may recover its generic
  delivery from Nucleus's durable task, run, review, verification, merge, and
  closeout state. That recovery must be deterministic, event-specific, exposed
  in history, and rejected when one fact is absent or ambiguous. It may not
  parse Northstar documents or invent provider evidence.
- `eventId` and hook occurrence remain stable. Unknown process, commit, or push
  effects remain non-retriable until reconciled.

### Isolated integration write

- Create a Nucleus-owned isolated Git checkout at the exact synchronized event
  base under a durable creation intent. New checkouts live under the Nucleus
  data directory (`isolation/<digest of the git common dir>/…`), never inside
  a repository. The former repository-local isolation root is retired
  (Tom, 2026-11-09). The hook's `repository.root` names the actual execution checkout.
- Run, inspect, stage, commit, and push inside that checkout. Preserve the
  existing manifest/executable pins, direct-spawn boundary, allowed-path
  equality, exact staging, trailers, normal push, remote verification, and
  repository integration turn.
- The operator's canonical checkout must start on the expected base branch with
  clean tracked and untracked state and the exact base commit. Pre-existing
  ignored content is allowed and left byte-for-byte untouched.
- After remote publication, fast-forward the canonical checkout to the exact
  published commit and prove it matches the remote. Refuse collisions with
  ignored paths, a moved branch, tracked/untracked dirt, or a changed base.
- Nucleus removes only the isolated checkout it created, after a proven terminal
  result. Ambiguous creation, execution, commit, push, synchronization, or
  cleanup remains visible for reconciliation. It never removes an operator or
  agent workspace.
- No-manifest behavior remains unchanged. Read-only hooks ignore Git-ignored
  runtime entries while preserving HEAD, index, and non-ignored worktree state.

### Ignored runtime artifacts

- In either mode, ignored entries are outside mutation and publication
  comparisons. Nucleus does not require the hook to declare them and never
  stages, commits, copies, or publishes them.
- Every non-ignored entry still passes declared-result equality, allowed-path,
  unstaged-only, regular-file, symlink, special-file, deletion, and submodule
  checks before Nucleus creates a commit.
- A runner/task regression writes one ignored receipt and one declared file.
  The declared file alone is committed; the receipt never reaches canonical
  or remote history. A read-only companion fixture proves the same receipt does
  not hold its transition.

### Bounded ignored inventory

- Status inspection asks Git for matching ignored paths instead of the
  traditional recursive ignored listing. Git may report an ignored directory
  boundary; Nucleus must not enumerate every ignored leaf before filtering it.
- `--untracked-files=all` remains in force. Tracked, staged, renamed, deleted,
  and non-ignored untracked state retains the existing complete inspection and
  rejection behavior.
- Ignore classification and synchronization collision checks accept branch
  boundaries. A publishable path equal to, below, or above a reported ignored
  branch still collides and must hold the transition.
- The existing Git output safety buffer remains a hard bound. Increasing it,
  deleting or moving caches, or omitting non-ignored paths is not a repair.

### Pre-commit uncertain reconciliation

- `retry_hook` may recover an `integration_write` record from `uncertain` only
  when its state proves the attempt stopped before Nucleus's commit intent.
- The proof requires no matching event commit locally or remotely; canonical
  `HEAD` and `origin/<base>` both equal `baseCommit`; the recorded isolated
  checkout exists at the same `HEAD` and branch; and its complete status is
  limited to ignored entries plus non-ignored entries within the manifest's
  allowed paths. When a parsed result was durably stored, declared-result
  equality must also hold. The live pre-fix record has no stored result because
  inspection failed after parsing, so its recovery may use the stricter
  allowed-path proof before discarding the disposable checkout.
- A proven pre-commit record returns to retryable intent and Nucleus replaces the
  disposable checkout on the next confirmed attempt. Moved refs, non-ignored
  paths outside the manifest allowance, an absent or wrong checkout, or any
  matching commit remains uncertain.
- Records at or beyond `commit_intent` keep the existing commit/trailer/tree,
  push, remote, synchronization, and cleanup reconciliation. This path cannot
  classify commit or push uncertainty as pre-commit.
- Non-zero hook diagnostics include a bounded UTF-8 stderr excerpt inside the
  existing stored error limit. A hook that exits zero but whose result is not
  `ok`, or whose result Nucleus cannot parse, keeps the same bounded excerpt
  beside the wrapper exit status and the result state. The three facts stay
  distinct: Nucleus records the exit code it observed, the structured outcome or
  that no usable result came back, and the stderr bytes the program wrote. It
  never infers an inner exit code and never states that there was nothing to
  stop, and absent stderr is simply not mentioned. The excerpt is redacted by
  construction, through the closed launch environment, so the program never
  holds Nucleus credentials to print. Timeout and output-limit
  outcomes retain their dedicated messages and never expose unbounded process
  output.

## Acceptance matrix

| Invariant | Counterexample | Required proof |
| --- | --- | --- |
| Retry fidelity | A blocked retry replaces reviewed head, merge identity, or integration identity with `null` | Capture first and retried event payloads; all immutable facts equal and attempt advances once |
| Live migration | The current blocked record needs a replacement task/event or loses its evidence | Schema migration fixture plus exact live-record recovery path with stable task, hook, event, and occurrence IDs |
| Operator evidence survives | Nucleus deletes, moves, rewrites, or silently ignores mutation of `.effigy` history | Isolated-checkout fixture with ignored files and byte digests before/after publication |
| Exact base | Hook runs from a dirty, stale, wrong-branch, or wrong-commit source | canonical-base and isolated-HEAD refusal matrix |
| Bounded publication | Isolated execution weakens allowed paths, staging, trailers, push, or remote proof | existing hook matrix replayed through the isolated writer |
| Safe synchronization | Remote advances but canonical checkout is clobbered or left behind | collision, concurrent-main, and fast-forward fixtures with uncertain state retained |
| Durable cleanup | Restart duplicates a worktree, loses a published commit, or removes someone else's workspace | restart fixtures around create, run, commit, push, sync, and cleanup intents |
| Generic core | Recovery or checkout code imports Northstar vocabulary or paths | source scan and plain JSON-ledger retry fixture |
| Compatibility | Repositories without write hooks or with read-only hooks change behavior | existing suite and serialized no-manifest/read-only proofs |
| Ignored runtime containment | A tool receipt is rejected, declared, or published from an isolated write checkout | synthetic runner writes one ignored receipt and one declared file; only the declared file is committed |
| Read-only strictness | Filtering ignored runtime artifacts also permits a tracked, staged, or untracked canonical mutation | read-only hook writes an ignored receipt and succeeds; non-ignored mutation still holds with canonical evidence |
| Pre-commit retry proof | Any uncertain attempt is reset despite a moved ref, missing checkout, unexpected path, or possible commit | exact pre-commit positive fixture plus each refusal counterexample |
| Diagnostic bounds | A non-zero runner hides its useful error or stores unbounded stderr | bounded excerpt fixture with truncation and unchanged timeout/output-limit messages |
| Failed-result evidence | A zero-exit runner that reports `blocked`/`failed`, or no usable result, loses the stderr that explains it | exit-0 fixtures for a structured failure, an empty and a malformed result, an oversized multibyte excerpt and a no-stderr refusal; each keeps the wrapper exit, the result state and the available stderr inside the existing bound, and a successful or non-zero run is unchanged |
| Bounded ignored inventory | A large ignored tree is fully enumerated until Git output exceeds the safety buffer | ignored-tree fixture proves branch-level status while non-ignored untracked dirt remains visible |
| Ignored collision fidelity | Collapsing an ignored tree hides a new tracked publication at or below its branch | exact, ancestor, and descendant collision fixtures reject synchronization |

## Live proof

After the implementation is merged, typechecked, and the plugin alone is
reloaded, retry hook record `1a2951fb-5dbf-4768-8c57-017ca76fc106` on task
`b45c4f85-aa3c-46b4-920d-0bd26773faca`. Required proof:

1. the same event ID and occurrence are used with the preserved non-null
   delivery facts;
2. the hook publishes only its declared Northstar lifecycle/projection paths;
3. Northstar's canonical checkout and remote main converge on the hook commit;
4. all 5,756 pre-existing ignored artifacts retain their byte identity;
5. the Northstar task reaches `done` without a replacement task or manual DB
   edit; and
6. repeat delivery is no-diff and does not create a second publication.

The g01.014 proof uses Northstar task
`7bb47c84-37a6-4873-a6b3-5bb6db925548`, hook record
`94398647-102f-4ff2-8778-5deab5450f68`, stable event ID
`84da90598bc3940685f953dd27d0926f68ae0a6a7d457dc8`, and PR #49. Its
attempt-2 uncertainty contains the expected declared lifecycle edits plus one
ignored runner receipt, no commit, and no remote publication. After the repair
is merged, typechecked, and the plugin alone is reloaded, Nucleus must reconcile
that exact record through the proof above, retry it with `retry_hook`, publish
only the five declared lifecycle paths, and take the same task to terminal
closeout. No manual Northstar edit, task replacement, occurrence replacement,
or identity change is allowed.

The g01.016 proof uses Effigy task
`328ead4c-1e15-4b72-b8ef-3c926df9be70`, hook record
`6845f8d2-da94-4364-95c7-ea2ba5d023f3`, stable event ID
`95a31fdb7789810c16ff6bf9777efabd6f3b8f76cee05c14`, and PR #105. Its
closeout is blocked before isolated-checkout creation because the canonical
checkout contains 195,606 ignored leaves whose porcelain output exceeds the
16 MiB Git safety buffer. After the repair is merged, typechecked, and only
this plugin is reloaded, Nucleus must retry that exact occurrence. Effigy main
must stay on its synchronized base until the hook publishes normally; its
ignored `target`, `.effigy/linux-release`, and `.effigy/reports` trees remain
in place and untouched.

## Revision: reaping is linear, orphans are reconciled, errors are bounded (2026-10-25)

Tom's performance audit (items A10 and B5) measured the hourly reaper against a
10,679-row occurrence table whose 10,460 rows belonged to purged tasks.

- **Linear walk.** Eligibility is answered from two indexes built in one pass —
  the latest occurrence of each logical event, and the unresolved evidence per
  event ID — instead of a `records.some(...)` scan per record, and each task is
  read once instead of once per occurrence.
- **Purged tasks are skipped.** A task that no longer exists is not an error.
  Such an occurrence is reconciled only when its own recorded checkout is
  positively absent: the row is then deleted in bounded transactions, because
  its task and every derived ownership path are gone. An occurrence whose
  recorded path exists or cannot be read keeps its row, is counted in the
  pass's orphan figures and deletes nothing.
- **No checkout, settled: reconciled (Lean store 2, task 987).** A settled
  occurrence that names no checkout holds none (`hook-retention.ts`), so an
  orphan of that shape is reconciled too. An unsettled one keeps its row, since it
  may still own a checkout that no record names.
- **Bounded health.** The pass keeps an exact failure count and carries the
  first twenty failures, each naming the occurrence and the reason, instead of
  appending a string per occurrence for the life of the store. The record lives
  in `service.health`'s `hookCleanup`.
- **Ownership is unchanged.** Only an exact event-owned directory under a
  Nucleus-owned root is removed, a recorded path outside those roots is never
  trusted, and a shared event ID with unresolved write evidence is never
  disposable. Retention's own ordering and gate are owned by
  [Spec 018](018-queue-owned-closeout-and-durable-outcomes.md).

## Non-goals

Northstar lifecycle semantics, document parsing, new public event fields,
remote hooks, a general job runner, relaxed path validation, deleting local
evidence, larger Git output buffers, live SQLite edits, task replacement,
thread/workspace cleanup, UI, CI, release changes, and unrelated Nucleus
scheduling work.

## Stop conditions

Stop if the repair needs Northstar knowledge in Nucleus core, cannot preserve the
original delivery evidence, retries an uncertain external effect, writes from
an unverified base, mutates ignored operator artifacts, weakens exact-path or
normal-push proof, edits the live database directly, or requires replacing the
existing Northstar task or hook record.
