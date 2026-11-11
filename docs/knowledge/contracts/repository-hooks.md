# Repository hooks

Owner: operator and Chatterbox
Updated: 2026-10-05
Governing specs: `docs/knowledge/specs/001-generic-repository-hooks.md`,
`docs/knowledge/specs/002-durable-hook-retry-and-isolated-writes.md`,
`docs/knowledge/specs/004-trusted-host-hook-runners.md`,
`docs/knowledge/specs/007-reviewed-head-pre-merge-hooks.md`,
`docs/knowledge/specs/018-queue-owned-closeout-and-durable-outcomes.md`,
`docs/knowledge/specs/022-queue-projects-without-manifests.md`

Nucleus may execute repository policy only through an optional committed
`.paseo/queue.json` using `paseo.queue.control.v1`,
`paseo.queue.control.v2`, `paseo.queue.control.v3`,
`paseo.queue.control.v4`, `paseo.queue.control.v5`,
`paseo.queue.control.v6`, or `paseo.queue.control.v7`. Absence means no
repository hooks and no lifecycle binding; closeout for such repositories
follows Nucleus's project settings below. Nucleus core treats the instruction
artifact and hook payload as opaque generic data; it does not import Northstar,
parse a document system, recognize project task numbering, or embed
repository-specific commands and paths.

Approved, not yet built (R5 in [vision](../vision.md#simplification-rulings-2026-10-31)):
retire the integration-write mode with its isolated publication, closeout
authority, and collapse the control and event schemas to one version each. The
trusted runner approval registry is retired; hooks can name host tools directly.
Everything below describes installed behaviour.

A hook binds a repository executable or named host tool and literal arguments to named
versioned Nucleus events. Nucleus uses no shell interpolation. It pins manifest,
executable, instruction, repository base, event ID, mode, delivery policy, time
and output bounds before execution. Read-only hooks must preserve HEAD, index,
and every non-ignored worktree entry. Integration-write hooks run from a
Nucleus-owned isolated checkout at the exact synchronized event base and may
change only declared paths. Hooks never stage, commit, push, merge, or choose
their publication scope.

Git-ignored paths are runtime-local in both modes. Nucleus excludes them from
read-only mutation comparison and from an integration-write hook's publishable
change set and allowed-path comparison. It leaves ignored bytes untouched and
never stages or publishes them. Nucleus still rejects every staged, undeclared,
symlinked, special, submodule, or otherwise invalid non-ignored path. The
read-only baseline captures the staged index and worktree status without taking
the shared repository index lock, so concurrent baselines and lane integration
in one checkout cannot present a good submission as a failed baseline. An
unavailable after-snapshot is an operational hold with its own reason, never
evidence that the hook mutated the repository. See spec 016. A
Nucleus-owned isolated checkout remains removable without force once ignored
runtime material is all that remains beside a proven terminal result; any
non-ignored change still blocks that removal.

A read-only integration-base hook runs in the canonical checkout, which planners
also push from. If HEAD moves during the hook only because the base fast-forwarded
to the published origin tip, the occurrence is superseded rather than uncertain.
The proof requires a checkout that is clean before and after, still on the base
branch, and whose index is exactly the new HEAD tree, with HEAD equal to origin. The
record keeps `baseAdvance` evidence, and the next emission evaluates the new base.
A superseded `task.pre_dispatch` gate leaves the task queued, and dispatch re-runs
it at most three times before the hold reaches a human. `retry_effect` on such an
occurrence, or on an uncertain pre-dispatch occurrence whose base has since become
a clean published fast-forward, supersedes it and runs a fresh gate at the current
base. A local commit, a dirty tree or an unpublished head stays uncertain. Nucleus
cannot tell a planner's push from a hook's own push; that residual risk is accepted
because the resulting checkout is clean and published either way.

Git status inventory must stay bounded without weakening those gates. Nucleus
requests matching ignored paths, so Git reports ignored branch boundaries
rather than every ignored leaf. Non-ignored untracked paths remain exhaustive.
Untracked macOS metadata (`.DS_Store`, `.localized` and `._*` AppleDouble
files) is excluded from source cleanliness checks by the shared path filter;
Nucleus preserves those files.
Branch entries are sufficient for ignore classification and collision checks:
an equal, ancestor, or descendant relationship with a publishable path still
blocks synchronization. Nucleus does not raise its Git output safety bound or
delete, relocate, enumerate, or trust ignored runtime trees to make a checkout
eligible.

Nucleus records intent before every external effect. It validates
`paseo.queue.event.v1` and `paseo.queue.hook-result.v1`, stores bounded results,
stages exact allowed paths, creates the commit, pushes normally, fast-forwards
the operator checkout to the published commit, proves the remote, and removes
only the isolated checkout it created. Restarts reconcile uncertain process,
creation, commit, push, synchronization, and cleanup outcomes by stable event,
manifest, base, trailer, tree, and remote identity before retry. Required
blocked/failed hooks hold their transition. Advisory failures may advance only
after Nucleus proves that no repository mutation remains uncertain.

A failing hook keeps bounded evidence whichever way it fails. A non-zero exit
and a zero exit whose structured result is `blocked`/`failed`, or unusable,
both record the exit status Nucleus observed, the result state, and a bounded
UTF-8 stderr excerpt, inside the stored error limit. The excerpt is bounded and
redacted by construction: the hook runs with the closed launch environment, so
it never holds Nucleus's credentials to print and a secret-shaped token can only
be text the program wrote itself. A missing excerpt is simply not mentioned,
and nothing is invented. Timeout and output-limit outcomes keep
their own messages. See spec 002 for the bound and its acceptance matrix.

An uncertain integration-write attempt may return to retryable intent before
commit only when Nucleus proves that no matching local or remote publication
exists, canonical and remote heads still equal the pinned base, the isolated
HEAD and branch still equal the pinned base, and every checkout-local entry is
either a manifest-allowed non-ignored change or ignored runtime material. A
stored parsed result adds exact declared-path equality to that proof. Commit
and push uncertainty keeps the existing stronger publication reconciliation;
this pre-commit proof cannot erase or retry a possible external effect.

An operator may explicitly discard a provably unpublished integration-write
checkout with `retry_effect` and `discard: true`. This applies
to every integration-write event, including blocked and cancelled occurrences.
Nucleus proves the canonical base clean and synchronized, the remote readable,
all recorded or matching event commits unpublished, and the exact owned directory
and branch. Missing Git metadata requires a creation failure before invocation:
attempt zero and no process, result, commit or remote intent. Other metadata loss
refuses. Disposal intent is durable before removal; closeout keeps its recorded
synchronized base. The old occurrence and immutable delivery remain evidence.

`cleanupOnly: true` limits that authority to disposal. The occurrence remains
blocked through restart and later emissions, without execution or publication.
Only another explicit disposal retry without cleanup-only authority may mint a
replacement. Ordinary retry and automatic replay cannot release this hold.

Every hook record persists the immutable occurrence payload — event ID,
original occurrence time, repository base, task/instruction identity, delivery
object, and manifest and executable pins — so a retry reproduces the original
delivery with only the confirmed attempt advancing. It never rebuilds delivery
from the current task reason and never replaces a non-null fact with `null`.
Pre-existing records upgrade from schema 3 to schema 4 in one transaction that
preserves every task, setting, pool, availability, limit, pause state, run,
notice, and hook identity. A pre-migration record whose occurrence facts are
durably reconstructible rebuilds them from Nucleus's own task, run, review,
verification, merge, and closeout state; a missing or ambiguous fact is
rejected and exposed in history rather than guessed.

The current Northstar handoff submission is an adapter to the generic committed
instruction artifact. Closeout authority is selected per repository from the
manifest pinned at the synchronized integration commit. A required
`integration_write` hook bound to `task.closeout` owns closeout: Nucleus emits the
event without creating a closeout agent or workspace, and the hook result and
published integration commit determine completion. Required hook failure or an
uncertain effect holds the transition; Nucleus never falls back after selecting
hook authority. Its successful result represents one complete repository
projection transaction: the repository adapter replaces any older local
lifecycle authority its terminal projection supersedes and validates the
prospective result before returning `ok`. Nucleus publishes only the exact
declared paths and does not interpret their syntax. See spec 006.

For a closeout occurrence held solely because the integration base moved, Nucleus
compares its recorded base with the canonical checkout's current HEAD. A normal
lifecycle pass renews it only when that HEAD is a clean, synchronized
fast-forward and the automatic exact-identity proof below succeeds. The old
occurrence remains evidence, and the replacement uses the existing replay cap.
An owner `restart` can still re-synchronize main and resume closeout, but a
plain base advance does not require operator action. A refused automatic proof
cannot enter the separate repair path for a semantic closeout refusal.

A closeout the hook itself blocked is a consumer finding: result `blocked`, no
changed paths, commit or remote. Nucleus never overrides it and never re-asks on a
moved base alone. The lifecycle pass re-asks only after the remote base branch
fast-forwards from the blocked occurrence's base through the hook's declared
`allowedPaths` or its control manifest. It then takes the owner's
parked-restart transition: refresh main, then supersede the unpublished
occurrence at the new base. A consumer that still blocks parks again at that
base. Each merge gets at most five of these re-asks; after that, an operator
decides. The pass fetches the base branch for a repository holding such a
closeout at most once every five minutes.

The same pre-publication rule applies to a held `task.cancelled` integration
write when unrelated work advances main. A repeated disposition or explicit
hook retry proves that the stale occurrence has no commit or remote effect,
retains it in history, and mints the cancellation against the current clean
synchronized base. Nucleus never rolls an occurrence after commit intent.

When no required `integration_write` `task.closeout` hook is bound and the
manifest does not select Nucleus closeout, a manifest repository uses the
existing closeout agent. Any advisory or read-only closeout hooks remain
post-closeout observers on that legacy route. Nucleus does not interpret what the
hook writes.

### Nucleus-owned closeout (v5)

Spec 018 adds `paseo.queue.control.v5`. v1–v4 stay frozen. v5 keeps the v4 hook
definitions, makes `hooks` optional, and adds `closeout`: `"queue"` or
`"hooks"`, default `"hooks"`. `"hooks"` is the v4 selection: a required
integration-write `task.closeout` hook owns closeout, otherwise the closeout
agent. `"queue"` completes after merge verification and main synchronization
with no closeout run, workspace, hook occurrence, commit or push.

`closeout: "queue"` with any hook bound to `task.closeout` is an invalid
manifest and is refused, never resolved by precedence. `validation` is reserved
for Spec 042 item 3; a v5 manifest containing it is refused with a message that
names that missing capability. The schema stays strict.

Closeout authority is read at the task's synchronized integration commit, so a
repository switches per commit. A closeout already held under hook or agent
authority keeps that authority until it settles.

### Project settings and the no-manifest default (Spec 022)

A repository with no manifest at the synchronized commit receives Nucleus-owned
closeout by default: no closeout run, workspace, hook occurrence, commit or
push, with the durable outcome row written as for a v5 `closeout: "queue"`
repository. Nucleus holds per-project settings in its own permanent `projects`
table, so a project repository carries no Nucleus files. One row per repository,
keyed by the same identity as outcomes, lanes and task numbers — the
normalised origin (`owner/name`) plus the local path as a hint — with an
optional `closeout` override (`queue`, the default, or `agent`), an optional
operator note and `updatedAt`. Rows are never purged and host-neutral. A row
binds by origin identity: when the checkout's origin can be read, a row matches
only if their origins agree, so a reused local path never carries an old
project's override to a new repository; the path hint matches only while the
row is path-keyed or the origin cannot be read, and a write absorbs only a
path-keyed predecessor.

- A manifest, when present, still governs its repository; the project override
  applies only where there is none.
- The override is read at the synchronized commit with the manifest. A closeout
  already running under agent authority settles under it; later closeouts use
  the current setting.
- Operators read and set rows through the `repository.get`, `repository.set`
  and `repositories` RPCs and CLI. There is no board editing in this version.
- `repository.set` may carry `validation: { argv, timeoutMs, maxOutputBytes }` or
  `null` to clear it. This literal command runs in Nucleus's exact prospective
  merge candidate after accepted review for a repository with no manifest or a
  v5 manifest. Nucleus uses the minimal hook environment and installs nothing.
  Exit 0 passes; nonzero exit spends one semantic revision with a bounded,
  marked output tail. Timeout, launch failure, candidate mutation and stale identity hold or
  rerun without spending a revision. Task and outcome records retain the argv,
  digest, exit code, duration and output tail. v1–v4 manifest hooks remain the
  only gate for those repositories.
- Brief capture records the fetched pushed integration head (`origin/<base>`)
  as the planning commit and checks manifest eligibility there, not at the
  shared checkout's HEAD. Handoff capture keeps its committed-file rule.

## Automatic exact-identity replay

Nucleus may re-evaluate a required integration-base occurrence that only an
operational base race holds, instead of handing it to a recovery Coordinator.
One closed proof must be exact: the task, repository, base branch, disposition
and event stay applicable; the occurrence still carries the operational
stale-base refusal with no attempt result, commit, push, remote publication or
ambiguous process effect; the instruction path and digest, hook ID, target,
mode, delivery, allowed paths, commit subject, program pin and normalized
manifest semantics are unchanged at the new base; the previous Nucleus-owned
checkout is provably unchanged or safely disposable; and the canonical local
and remote integration heads are clean, equal and a fast-forward of the
occurrence base. Reviewed-head pre-merge, pre-dispatch, semantic refusal, dirty
state, changed identity and uncertain delivery never replay automatically.

A replay persists its intent and old-to-new lineage before creating the fresh
occurrence, serializes per repository, and keeps every old attempt as
immutable evidence. A fresh occurrence is only evaluated normally: a replay
never means the hook succeeded. Nucleus allows at most two automatic
base-advance replays per logical event; further movement or any failed proof
keeps the existing bounded recovery. Hook history shows the lineage and the
counter, and telemetry counts the replay separately from Coordinator recovery,
operator hook retry and semantic refusal. See spec 010.

## Reviewed-head pre-merge gate

Spec 007 adds `paseo.queue.control.v3`, `paseo.queue.event.v2`, event
`task.pre_merge`, and hook target `reviewed_head`. The result remains
`paseo.queue.hook-result.v1`. This event accepts only a required read-only hook.
It runs in the retained clean Nucleus task workspace after accepted independent
review and reviewer release, but before post-review verification or merge.

Nucleus pins the manifest, program, submitted instruction, accepted review, open
PR, queue branch, remote branch and exact reviewed head before process intent.
It proves those identities and a clean worktree before and after execution. The
event payload identifies `repository.target` as `reviewed_head`, uses the exact
reviewed head as `repository.baseCommit`, and leaves merge and integration
commits null.

A confirmed repository refusal after the no-mutation proof becomes an ordinary
semantic revision finding. It returns the same task, retained worker, workspace,
branch and PR to work and continues the open approved round without consuming a
review round (task 576, 2026-11-02): only a new `changes_required` review past
the cap can exhaust the revision budget, and a repeated refusal of one unchanged
head keeps its own bounded attention stop. The changed head needs fresh
independent review and a fresh hook occurrence. Execution uncertainty, malformed
transport, mutation and identity drift remain operational holds. A semantic
refusal does not create a closeout occurrence or incident and does not notify
Chatterbox.

One settled occurrence answers for one exact reviewed head: an unchanged head
is not gated twice, while a changed head mints a fresh occurrence. Only
`task.pre_merge` emits the additive v2 event; integration-base events bound in a
v3 manifest keep the frozen v1 payload.

Existing v1/v2 manifests and v3 manifests without this hook retain current
behavior. Nucleus does not infer a pre-merge gate from closeout policy or
interpret repository content.

### Prospective merge target

Spec 015 adds `paseo.queue.control.v4`, `paseo.queue.event.v3` and the closed
hook target `prospective_merge` for repository-wide pre-merge policy. It is
valid only for a required read-only `task.pre_merge` hook. `reviewed_head`
keeps its exact branch-local meaning and every v1-v3 manifest, v1-v2 event and
stored occurrence keeps its previous behaviour; `reviewed_head` remains
available for checks that intentionally inspect branch-local state.

Nucleus proves the current clean synchronized integration base, then builds the
exact normal merge candidate from that base and the accepted reviewed head in a
Nucleus-owned checkout outside both the canonical and task workspaces. While the
task holds the repository integration turn, Nucleus may use one warm checkout per
repository under the Nucleus data directory isolation root. Before each reuse it proves the
previous candidate pin, clean tree, detached HEAD, clone owner and remote, then
fetches and resets to the exact base and checks out the new synthetic commit.
Missing, dirty, displaced, foreign or occupied warm checkouts use the existing
candidate-specific disposable path. A lost warm checkout is re-created after a
fresh fallback. Candidate build and hook durations are recorded separately.
The candidate uses the same parent order (base, then head) and the same
three-way merge semantics as the configured GitHub `merge` operation. It is a
Nucleus-created synthetic commit: Nucleus records its commit and tree and never
claims the eventual server-generated merge identity. A conflict stops before
any hook process starts and uses the existing worker-update path. Neither the
worker branch nor the canonical checkout is written, rebased or pushed.

The occurrence pins the integration base, reviewed head, candidate commit and
tree, manifest, program, instruction and event before process intent. Durable
candidate-creation intent precedes the checkout, and both warm and disposable
paths are deterministic. An open occurrence keeps its pinned checkout; a warm
checkout with an open occurrence cannot be assigned to another candidate.
The manifest and program are pinned at the synchronized integration
base. A candidate whose bytes change the pinned program is an operational hold:
Nucleus never executes unreviewed policy content that redefines its own gate.

The event names the target, the accepted reviewed head, the pinned integration
base, the Nucleus-created candidate commit and tree, and the immutable submitted
instruction and accepted review evidence. `delivery.mergeCommit` stays null.

After a result Nucleus re-fetches the integration base and re-proves the open PR.
Base movement is operational staleness: it supersedes the occurrence without a
semantic refusal or revision cost and rebuilds at most one current candidate per
normal lifecycle pass. A gate that finds the local integration base behind origin
(`Local integration base differs from origin`) fast-forwards the integration
checkout to origin, then runs again. The fast-forward keeps the post-merge sync's
ff-only and clean-checkout proof without its merged-commit precondition, and a
successful renewal records `integration_base_renewed`. Dirty, wrong-branch and
locally ahead checkouts are never renewed; a refused renewal records
`integration_base_renewal_refused` and the gate parks on the stale-base detail.
A gate pass renews at most three times, so a base that origin keeps moving past
parks for an operator. Confirmed refusals at a stable base follow the ordinary
semantic revision loop; uncertainty, program drift, candidate mutation and
cleanup failure are operational holds. A disposable candidate is removed after a
settled result; a settled warm candidate remains available for the next
repository integration turn. An uncertain occurrence keeps its checkout for
bounded reconciliation and bars warm reuse. The merge gate must
still prove the same integration base and exact reviewed head, and base movement
between the hook and that proof discards the candidate result and reruns it
once.

Telemetry counts prospective-merge occurrences and stale candidate rebuilds
separately from semantic refusals, hook retries and recovery coordinators, and
the stored occurrence and native detail projection name the target, the base,
the reviewed head and the candidate identity. Schema 12 records the closed
target and the pinned candidate on every occurrence; a pre-migration record
derives them from its immutable occurrence payload and otherwise parses to the
integration base target with no candidate.

`reviewed_head` remains available for branch-local checks. Repositories choose
the target explicitly; Nucleus does not infer scope from a hook command or output.


## Pre-archive retention gate

Added 2026-10-04: a retained worktree must not be archived while consumer-owned
source material it alone holds is unretained.

The gate needs `paseo.queue.control.v6`. v1–v5 keep their frozen accepted event
sets and cannot bind `task.pre_archive`; v6 is the v5 closeout selection with
this event added. It emits the frozen v1 event payload, so no new stream or
export is introduced before the Nucleus contracts pin one.

- Event `task.pre_archive` accepts only a required read-only hook. It runs in the
  retained task worktree immediately before Nucleus archives that worktree for any
  reason: closeout archive, `retry_effect` and disposition archive.
  The workspace is preserved until the hook settles.
- The hook is consumer-owned. The repository declares what it must find and where:
  the mandatory origins, their hashes, and the durable primary location the source
  owner is authorised to use. Nucleus supplies only the event, the worktree path and
  the task identity. It never decides which files matter, never copies or retains
  arbitrary files, and never asserts rights.
- An `ok` result lets the archive proceed. A refusal or failure is an operational
  hold, "retention gate refused archive", with the hook's evidence. The worktree
  stays, the task stays in its current phase with the hold visible, and retry is
  the existing `retry_effect`. An uncertain effect holds the same way. Nothing is
  deleted on a timeout.
- Repositories without the hook archive exactly as before.

A read-only `task.pre_archive` occurrence whose last attempt only timed out
(it neither refused nor failed) runs again on the next cleanup pass, up to
three attempts in all; a refusal, a failure or the bound keeps the hold (Tom,
2026-10-19). The
record carries a structured `timedOut` flag, so the rerun never reads error
prose, and a read-only hook has no external effect to replay. The flag
describes the latest attempt only: an attempt that fails any other way,
including before its program starts, clears it. Only a timeout whose process
group was proven gone qualifies, so a rerun never overlaps a surviving
execution. A superseded reconciliation is never rerun, and concurrent cleanup
callers run one attempt between them.

## Merged-task retention reconciliation

Added 2026-10-05. A done, merged task can hold its retained
worktree on a refused `task.pre_archive` gate whose pinned manifest and program
predate the consumer's repair on main: the ordinary gate pins both at the
retained worktree head, so a correction merged afterwards never reaches the
refused occurrence, and `retry_effect` re-runs the same stale bytes. The task
stays on the Open board because any terminal task with a non-empty
`cleanupReason` keeps its worktree.

- Operator control `retry_effect` on `queue.task`
  takes the task id, version and a required reason. It is never invoked
automatically. Before any effect it refuses unless the task is done and
  merged with no merge intent pending, the latest `task.pre_archive`
  occurrence for the retained workspace is a settled refusal or hold, the
  retained worktree exists at exactly the recorded prHead and is clean, the
  merged commit is an ancestor of the current `refs/heads/<baseBranch>`
  commit, and the manifest there still binds the same hook id for
  `task.pre_archive`.
- The control mints one new occurrence with the manifest and repository
  program pinned at that integration base and runs it read-only in the
  retained worktree. Execution spawns the program blob pinned at the base
  from a Nucleus-owned ephemeral file outside the worktree — never the
  worktree file at the refused head — with the worktree as cwd, so a
  gate-program repair merged to main is what runs and the worktree stays
  untouched. The event uses the additive `paseo.queue.event.v4`
  payload: every v1 field is kept, and `repository` names
  `target: merged_integration_base` with the retention linkage (route
  `merged_task_reconciliation`, merged commit, observed task head, manifest
  digest at the base, and the refused prior occurrence). The hook record
  carries the pinned base, manifest digest and executable digest immutably,
  plus the prior linkage. Nucleus never parses declarations; the consumer's
gate reads the declaration from the Git object at the pinned base.
- A settled success of that reconciliation for the same task, workspace path
  and head satisfies the retention gate, so the next done-workspace pass
  archives without re-running the stale gate. A changed head, a dirty
  worktree or a different workspace re-gates normally; a refusal stays a
  hold with its evidence. A reconciliation is superseded once the ordinary
  occurrence it reconciled (its `priorEventId`) later settles ok: it no longer
  answers, so the ordinary gate runs every required hook again (one hook's
  pass never bypasses another), and `next` no longer lists the obsolete
  reconciliation as a pending effect (2026-10-19). Ordinary pre-archive emission and every active or
  unmerged task keep the worktree-head pin and the frozen v1 payload.
- The control stays CLI and engine only until the operator can see it in the
  UI; the Nucleus skill documents the retry as `retry_effect`. Design and acceptance
  oracle: [Spec 047](../specs/retired/047-merged-task-retention-reconciliation.md) (retired; `retry_effect` owns the retry).

## Finished-task runtime stop

Added 2026-10-04. Nucleus keeps a task worktree after closeout, but the
repository's `worktree.teardown` only runs when Paseo removes the worktree, so a
retained worktree needs its own stop.

- Event `task.finished` accepts an advisory read-only hook, and needs
  `paseo.queue.control.v7`; v1–v6 keep their frozen event sets and cannot bind
  it. A required-delivery or integration-write binding is refused, so the stop
  can never hold the terminal transition. It runs once in the retained task
  worktree when a task reaches `done` or `cancelled` and its worktree still exists.
- The repository declares the command, for example a stop that keeps volumes. Nucleus
  supplies the task identity, worktree path and final phase. It never chooses or
  hardcodes a runtime tool.
- A failure or timeout is recorded on the task's history as an advisory warning. It
  never holds or reopens the task, and never removes the worktree. It isn't retried
  automatically, and `retry_effect` re-runs it on request.
- The terminal transition records a durable intent on the task. A crash before or
  during the stop is recovered by Nucleus's lifecycle scan: the same occurrence is
  evaluated again, or a running occurrence is reconciled to uncertain so it is not
  re-run. This holds for a completed cancellation, which the ordinary lifecycle scan
  no longer visits. Concurrent callers - the inline stop and the recovery scan -
  share one execution: one occurrence is never claimed twice.
- Later archive still runs `task.pre_archive` and the repository's normal teardown.
- Repositories without the hook are unchanged.

After that hook, Nucleus also reaps leftover **host** processes the repository
stop does not see: a host loop in the retained worktree, or a detached child in a
process group Nucleus recorded for the task's own worker, reviewer, revision,
validation or hook runs.

- Nucleus selects processes owned by the host uid whose cwd is inside the retained
  worktree (realpath prefix) or whose process group is one it recorded for that
  task. It never selects by command pattern.
- A recorded process group is selected and signalled only while a live member
  still proves the recorded group identity. A recycled or stale pgid never
  selects another task's run group. Each pid's start identity is checked again
  between discovery and the signal.
- Process discovery reads parent pids and the Paseo daemon pid from
  `~/.paseo/paseo.pid`. The daemon, Paseo app and Supervisor processes, every
  descendant of the daemon, and every process in the daemon's process group are
  excluded. If the pid file cannot identify the daemon, cwd matching still
  excludes processes whose ancestry includes a Paseo app binary.
- It never signals a process group shared with Nucleus or Paseo, or a pid whose
  start identity changed between discovery and the signal (a recycled pid).
  Nucleus stops its own threads through Paseo lifecycle controls, never by signal.
- A task that has eligible Paseo-owned processes records one informational
  history event listing the skipped processes. This is not a sweep failure and
  repeated lifecycle passes do not add another skipped-process event.
- Signal is SIGTERM, a short grace, then SIGKILL for survivors, by pid or pgid
  only.
- One task-history event lists each terminated pid, pgid, start time, cwd and
  truncated argv (no environment), and any it could not stop. Failure is
  advisory: it never holds or reopens the task.
- The same sweep runs before workspace archive. A durable intent, same shape as
  `task.finished`, recovers a crash that skipped it, including a completed
  cancellation the ordinary lifecycle scan no longer visits.

## Host tools

A hook may select `{ "kind": "tool", "name": "effigy", "argv": [] }`.
The name is a plain executable name, without slashes or interpolation. At intent,
Nucleus resolves it on the service PATH and records its real path and SHA-256
digest for audit. It executes that path with literal arguments and `shell: false`.
A missing tool records a plain error: required delivery blocks and advisory
delivery fails. The legacy `trusted_runner` manifest shape maps to a tool name;
old occurrence records remain readable, but their registry-pinned artifacts do
not execute. Repository executable behavior is unchanged.

The approval registry and machine binding are retired. Existing `runners.json`
and `runner-artifacts/` remain in place and unread; the data move may copy them
as unknown durable entries.

Committed instruction and executable blobs are cached by checkout identity, full
commit and path, with bounded entries and bytes. Mutable refs, working files and
merge gates remain fresh; pre-merge passes share one repository task list.
