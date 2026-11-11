# 056 — Repository namespace re-key

Status: implemented

A repository's Nucleus identity is its normalised origin (`owner/name`) with an
optional local path hint. Renaming a repository on the forge changes that
identity. This spec defines one operator-invoked step that moves every *current*
record naming the old identity onto the new one, atomically and idempotently,
without merging it with another repository that later claims the old name and
without rewriting a single historical fact.

It never renames a checkout, a Git remote, a branch or a forge repository, and it
makes no network call. The operator performs those changes separately, in the
order below.

## Why a re-key is not a rename

A GitHub rename leaves Nucleus's records under the old origin. Left alone, the old
identity keeps answering: the repository's settings, its permanent outcome rows,
its task-number counter and its pinned history all stay under a name that now
belongs to nobody. A different repository that later takes the vacated name then
inherits that numbering and those outcomes — the parent behaviour
`test/repository-rekey-sequence.test.ts` falsifies. Deleting rows or rewriting
them as history would lose permanent evidence instead. A re-key is the third
possibility: move current ownership, keep history verbatim.

## Operation

One RPC, one durable operation kind, one receipt:

- `repository.rekey-preview` (`repository.rekey-preview`) reads what a fresh
  apply would do. It writes nothing and is never authority to apply a later,
  drifted input.
- `repository.rekey` runs as the durable `repository_rekey` operation through
  the public RuntimeOwner envelope. The apply is one SQLite transaction; the
  receipt commits with the records.
- `repository.rekey-receipt` reads one durable receipt by its caller key or id.

Input:

```json
{
  "source": "owner/old-name",
  "target": { "origin": "owner/new-name", "path": "/optional/new/checkout" },
  "sourcePath": "/optional/current/checkout",
  "expectedSourceRevision": 12,
  "reason": "why the operator authorized this step",
  "author": "operator",
  "relayedBy": "<agent id when an agent relayed it>",
  "idempotencyKey": "repository-rekey:owner/old-name:owner/new-name"
}
```

`expectedSourceRevision` is the repository settings revision the caller observed
(`null` when the source has no settings row). A settings write since that read
refuses the step, so a preview cannot be used to apply drift. `path` is optional:
without it every path hint stays exactly as it was, because a forge rename does
not move a checkout. Same origin with a different `path` is a path-only step:
every path hint of this origin moves, numbering and references stay, and the
source origin is not `target_occupied`. Same origin with no path, or with the
same path, still refuses `source_equals_target`. `sourcePath` is the current
checkout when the settings row has none and the source's own records disagree;
omit it when settings carry the path, or when every matched record names the
same one — the step derives it then, and never guesses among several.
`idempotencyKey` is required and the CLI never invents one.

## What moves (current ownership)

| Family | Field |
| --- | --- |
| `repository_settings` | row key and `repository` (origin, optional path) |
| `task_number_counters` | `repository` |
| `task_numbers` | `repository` (live and purged, so numbering-only history follows) |
| tasks | `repository`, optional `repoPath`, `reviewEntry.repository`, `siblingPins`/`siblingFindings` repository |
| outcomes | `data.repository`, the searchable `repository` column, `siblings[].repository` |
| leads | `repositories[]`, `targets[].repository` |
| lanes | `repositories[]` |
| brief drafts | `repository`, optional `repoPath` |
| decisions | `askedBy.project` |
| projects, project tombstones | `repositories[]`, `primary` (the project key, name, version, owner and plan stay) |
| project QA runs | `data.repository`, `data.key`, the `repository` column and the latest-run index key; `data.submittedKey` records the key the row was submitted under |
| QA schedule merges | `repository` |

**Matching rule.** A record joins the re-key only when its own repository
identity says so, and identity is origin-first, exactly as `putRepository` and
`repositoryMatchSpecificity` keep it: a record that already knows a different
origin is never claimed through a shared checkout path. A path matches only a
record with no origin of its own (a path-only predecessor) and a task whose
`repository` is empty but whose `repoPath` names the source. This matters because
two known-origin repositories can share a checkout path: without the rule, an
explicit-path re-key of A would rewrite B's `repoPath`, B's draft and B's
milestone-QA routing column. Two origin-known settings rows at one path make a
*path-named* source ambiguous, which refuses (`ambiguous_source`) instead of
choosing one. A path-only step still reaches origin-matched records when the
settings row has an empty path: the old checkout is the unique path hint those
records already carry, or `sourcePath` when they disagree, never a guess.

Task and outcome rows are edited as stored JSON: only the fields above change, so
every other byte — brief text, review text, PR URL, commits, digests — stays
identical. `task.number`/`reference` are derived from `task_numbers` on read, so
numbering follows the counter without touching the task row.

**Milestone QA keeps its producer's identity (task 445).** A QA host run's caller
is minted from the run's one-run key (`qaCallerIdentity`) and the contract-010
host-run row is history, so the caller always names the key the run was
*submitted* under. Moving that QA row's `key` without recording it would make the
retained-output sweep reject the run's authentic producer. The step therefore
writes `data.submittedKey` — the row's key before this step — in the same
transaction that moves `key`, only when `key` actually moves, and never
overwrites it, so a chained re-key keeps the first submitted key. The field is
Nucleus-private: milestone QA runs are operational history outside the contract
010 wire shapes, so no export or wire shape changed, and a row re-keyed before
the field existed is still verifiable from the applied receipts,
which this step writes in the same transaction. A step with an explicit target
path also moves the row's checkout; the recorded submitted key is therefore bound
by the identity it names, not by the checkout it named then, and the retained
output sweep accepts the authentic run either way (Spec 035, "Identity binds; a
moved checkout is the run's own fact").

## What stays (historical facts)

`operations` (payload and `inputHash`), hook events, contract-010 host-run rows
and their journals, retained shadow-journal history, callback receipts, the
read-only legacy `papercuts` table, author-side proof executions and an outcome's
permanent proof fields keep the identity they were written under. They are
evidence of what happened, not routing for what happens next, and the receipt
names them as deliberately historical. No reader is given an old-origin redirect:
once the old name is free, a redirect would let another repository's lookups
resolve into this one's history, which is exactly the merge this feature exists
to prevent.

A settled host run is history and is never rewritten, so it never occupies a
name either: the documented Full swap must be able to let the CLI take `project-d`
after the desktop, even though the desktop ran QA under that name for months.
Occupancy is current ownership only. What blocks the step is unsettled custody —
a `queued`, `admitted` or `running` run, or a `settled` run that still holds
capacity (exactly the rows the QA inventory lists as unresolved).

Keeping those rows authentic has one bounded, accepted consequence: historical
admission samples recorded under the old name stay visible to the selector-sample
read the new owner's dispatch uses for its budget estimate, because the sample
filter reads the pinned record's own repository fields. Nothing routes, merges or
is authorized by them, and rewriting the pinned contract-010 row to change that
would destroy the evidence the same contract requires Nucleus to keep.

## Refusals

Every refusal happens before any write, and the caller sees one typed code and
one explanation:

| Code | Condition |
| --- | --- |
| `unknown_source` | no Nucleus record names the source |
| `ambiguous_source` | a path-named source is shared by more than one origin-known repository |
| `source_equals_target` | normalised source and target are the same origin and the path is unchanged |
| `invalid_target` | the target is not a normalised `owner/name` origin |
| `target_occupied` | the target origin appears in **any** current family, including a counter with no settings row; a path-only step does not treat the source origin as occupancy |
| `path_occupied` | the requested path is used by another repository |
| `active_tasks` | a task under the source is not done or cancelled |
| `active_operations` | an unsettled durable operation could still write under the source |
| `active_runs` | an unreleased worker or reviewer run belongs to the source |
| `active_qa` | a milestone QA run or QA request is still unsettled for the source |
| `active_host_runs` | a contract-010 host run is still unsettled for the source (queued, admitted, running, or settled holding capacity) |
| `pending_side_effects` | an actionable brief draft could still be promoted under the source |
| `source_revision_changed` | the settings revision moved since the observed one |
| `receipt_conflict` | the caller key already names a different input |

There is no occupied-target exception, including for a swap. A refusal is a
definite outcome (the transaction rolled back before any row or receipt changed)
and settles the durable operation `failed`, never `needs_attention`.

## The Full swap sequence

Tom's 2026-10-20 ruling ("Full swap after Queue fix"; recorded in
[questions.md](../questions.md)) has two steps, not one:

1. `inflatable-cookie/project-d` (desktop) → `inflatable-cookie/project-d-desktop`.
   Refused while `project-d-desktop` is occupied in any family.
2. `inflatable-cookie/project-d-cli` → `inflatable-cookie/project-d`. Refused
   until step 1 committed, because the CLI may not take the desktop's name while
   the desktop still holds it.

Each step is independently atomic and idempotent, and the desktop's numbers never
resolve into the CLI: after both steps `project-d-desktop#N` belongs to the
desktop and `project-d#N` to the CLI, whose counter continued from its own next
number (it never restarts at 1 and never absorbs the desktop's).

A genuine two-way swap (A↔B) uses a deliberately unused temporary namespace, one
step at a time: A→temp, B→A, temp→B. Each step refuses a collision on its own.

## Operator order and quiescence

Nucleus does not touch GitHub, Git remotes or checkouts, and no follow-redirect
rename is attempted. The operator's order for one step is:

1. Quiesce the repository in Nucleus: every task done or cancelled, no unsettled
   run, operation, QA run, QA request, host run or actionable draft. `next` and
   the board show those states; the re-key refuses while any remains.
2. Preview the step and keep the `expectedSourceRevision` it reports.
3. Apply with a stable `idempotencyKey`. A lost reply is reconciled with
   `repository.rekey-receipt` or the same operation key; never repeat with a new
   key.
4. Perform the GitHub rename and update the local remote (or leave the remote and
   let the operator's own tooling do it) **after** the Nucleus step commits. The
   vacated origin is free in Nucleus only after the step; doing the forge rename
   first leaves Nucleus pointing at a name another repository can claim.
5. Verify: `repository.get` for the new origin answers the moved settings row,
   `repository.get` for the old origin answers `null`, and a task reference under
   the old repository name no longer resolves. Repository auto-discovery must not
   be allowed to recreate a Nucleus task under the vacated origin between steps: no
   submission is started from the old checkout until the next step commits.

For the Full swap, run step 1 and its GitHub rename, verify the vacated name,
then run step 2 and its GitHub rename. The CLI's tasks may resume under the old
desktop name only after step 2 commits.

## Receipt

One row in `repository_rekeys`, keyed by the caller's idempotency key, binding:
the exact old and new identities, whether a path moved, the reason, the author
and the relaying agent, the time, the input hash, the observed source revision,
the affected-family counts, the numbering facts (`tasks`, `sourceNext`,
`targetNext`), the project keys and lane keys whose membership moved, and the
families deliberately left historical.

Repeating the same key with the same input returns that receipt (`replayed`); the
same key with different input refuses. The receipt is host-local operation
evidence, like a run receipt: the re-key's *effect* (identity ownership,
counters, references) is what the moved rows carry, and the receipt row is
host-local, so no Nucleus contract version is changed. A test asserted a
contract-008 export/import after each step before that export was retired
(2026-10-31); the moved rows are now asserted directly,
restores the same settings ownership, counters and task-number references and
never resurrects the vacated active namespace.

## Acceptance oracle

`test/repository-rekey-shot.test.ts` populates every covered family (settings,
numbering, tasks, outcomes, shared project, lane, lead, decision target, migrated
draft, QA run and schedule merge), a purged task with its permanent number and
outcome, overlapping number ranges, multiple path spellings and immutable
operation/hook/host-run/shadow evidence. It proves the single rename, historical
byte equality, unrelated-record equality, the receipt replay, and the changed-
input refusal.

`test/repository-rekey-sequence.test.ts` proves the desktop-final/CLI-takes-name
sequence, the temporary-namespace two-way swap, every refusal, a fault injected
at a family write and at the receipt write (both roll back completely), restart
persistence, the explicit-path versus origin-only distinction, a path-only
repository gaining an origin, a same-origin path move (including when the
settings row has an empty path and the live checkout lives on the records: every
family's path hint moves, numbering stays, a repeat returns the receipt, same
origin with the same path refuses, another origin at the old path is untouched,
another origin at the target path refuses `path_occupied`, and disagreeing
record paths without `sourcePath` refuse rather than guess), two origin-known
repositories sharing one checkout path (A's explicit-path step leaves B's task,
draft and QA routing untouched, and a path-named source refuses as ambiguous),
a settled host run under the desktop that stays byte-identical and blocks
neither step of the Full swap while a running or capacity-holding run refuses,
the parent collision for falsification, and the pre-change `previewRepositoryRekey`
(blob `b7851721` at planning `26f80ef0`) refusing the same-origin path-only
request with `source_equals_target` and `target_occupied`.

`test/repository-rekey-service.test.ts` proves the public RuntimeOwner path: the
preview writes nothing, the apply is one durable `repository_rekey` operation
with one receipt, a lost reply reconciles the same operation and receipt, and a
refusal settles failed with nothing written.

`test/repository-rekey-qa-ownership.test.ts` proves the QA consequence across
the same public path: a settled milestone QA run's authentic caller is accepted
by the default host-run endpoint's retained-output sweep after the step and a
restart, for both a row carrying the recorded `submittedKey` and the pre-receipt
shape whose original key follows only from the applied receipt, with the QA
producer's step logs untouched, no retention marker or byte count invented, and a
genuine unowned absence beside them still a durable failure.
`test/qa-caller-provenance.test.ts` proves the parent recomputation's failure and
every refusal — reversal, missing, corrupt and ambiguous receipts, a reused or
swapped name, a stale key on a later run, a foreign or another-run digest and a
changed epoch.

A backup taken *before* a re-key restores the pre-re-key namespace, exactly as
any restore restores the records of its moment. Re-running the step in a
restored fixture store moves the namespace it still owns; running it into a
store that no longer owns the source refuses as `unknown_source` rather than
merging anything.

The same boundary applies to a QA run's submitted key: the store carries the
re-key's *effect* on current ownership, and the QA history that proves a run's
original key is operational, so it travels only in the SQLite backups. A
restored store therefore holds that history, and a store without it reports the
run as an unknown absence rather than claiming an ownership it cannot evidence
(`test/repository-rekey-qa-ownership.test.ts`).

No live re-key, GitHub change, checkout edit, daemon restart or live database
write is part of this change.
