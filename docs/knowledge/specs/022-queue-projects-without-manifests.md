# 022 — Nucleus projects without manifests

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: Northstar Spec 042,
[Spec 015 prospective merge](015-prospective-merge-pre-merge-hooks.md),
[Spec 018 Nucleus-owned closeout](018-queue-owned-closeout-and-durable-outcomes.md)

## Goal

Tom approved on 2026-09-26: project repositories carry no Nucleus files at all.
Nucleus's behaviour for a repository comes from Nucleus's own store, not a
`.paseo/queue.json` in the repository. Manifests remain only for legacy
repositories until they migrate. This replaces Spec 042 item 3's manifest
`validation` field idea, which is dropped.

## No manifest means Nucleus closeout

`classifyCloseoutAuthority(null)` returns `queue`, not `agent`. A repository with
no manifest at the task's synchronized commit behaves like
`{ v5, closeout: "queue", hooks: [] }`: Nucleus-owned closeout, nothing written to
the repository, brief mode allowed. v1–v4 manifests keep their exact behaviour.
v5 stays accepted but is no longer needed.

**Planning identity reads the pushed head.** Brief capture records the pushed
integration head (`origin/<base>` after a fetch) as the planning commit and reads
manifest eligibility there, not from whatever commit the shared local checkout has
checked out. Consumer-b's cutover was refused because that checkout was still one
commit behind. Handoff capture keeps its committed-file rule.

**Who changes (checked on 2026-09-26).** Of the repositories Nucleus has used, four
have no manifest and currently get `agent` closeout. `nucleus` (11 of 11
closeouts), `effigy-catalog-pack` (2 of 2) and `underlay-effigy-bundle` (1 of 1)
used it to commit closeout logs, roadmap updates and handoff status.
`project-h` (1 closeout) wrote nothing. Under the new default they stop getting
those commits. A repository that should keep its closeout agent sets the project
override below. Tom ruled on 2026-09-26 that all three go lean, with no override.
Their documentation migrations land before g01.053 is rolled to the live service.

## Project settings

A `repository_settings` table in Nucleus's store, one row per repository, never purged and
host-neutral:

| Field | Content |
| --- | --- |
| `repository` | Normalised origin (`owner/name`), plus the local path as a hint; the same identity as outcomes, lanes and task numbers |
| `closeout` | Optional override for a repository with no manifest: `queue` (default) or `agent` |
| `validation` | Optional prospective-merge command (g01.054) |
| `updatedAt`, `note` | Last change and an optional operator note |

- Set through an operator RPC and CLI (`repository.set`, `repository.get`, `repositories`),
  and documented in the Nucleus skill. `repository.set` patches: only the fields named
  in the input change, an explicit `null` clears one, an absent field is untouched,
  and it returns the full resulting settings (papercut 3fbf11d1). There is no board
  editing in this version.
- A manifest, when present, still governs that repository; the project closeout
  override applies only when there is none.
- Closeout authority is read at the synchronized commit, as today. For a
  repository without a manifest, the authority is the project override when set,
  otherwise `queue`.

## Project validation command (Spec 042 item 3)

`validation` is `{ argv, timeoutMs, maxOutputBytes }`, an explicit argument list
with no implied shell, set by the operator. `timeoutMs` may be up to 1,800,000
(30 minutes): a fresh-checkout validation installs dependencies and runs the full
CI, which already takes about ten minutes for project-k. The run holds the
repository's integration turn while it lasts. Output past `maxOutputBytes` never
stops the run: Nucleus keeps a bounded beginning and end of each stream inside that
same cap, with a marker naming the observed, retained and omitted byte counts,
and the exit code decides. A capped stream never reads as complete output.
(Hooks differ: their output is their result, so a hook past its
limit is terminated.) It applies to repositories with no
manifest or a v5 manifest. Repositories on v1–v4 keep their manifest hooks and
never get a second gate.

- **When:** at the prospective merge, after an accepted review and before the
  merge, in Spec 015's Nucleus-owned candidate checkout: the exact reviewed head
  merged onto the current integration base. It inherits 015's freshness rules: a
  moved base or head reruns it and spends no revision round. A settled result
  is reused only while the environment that produced it is unchanged: the
  Nucleus build identity and the repository settings revision must still match.
  A settled result for an older PR head is recorded as superseded and cannot
  block review of the current head; validation runs again for that head.
  A changed build or a later settings write reruns an ordinary settled result; a
  lost or timed-out run stays held until an explicit retry. An unchanged
  environment still reuses, so automatic passes never loop.
- **Contract:** exit code 0 passes. A non-zero exit is a semantic refusal that
  returns to the worker as one revision round, with a bounded tail of the output
  as the finding (Spec 007's semantic loop). A timeout, a launch failure or a
  candidate left changed is an operational hold for the operator, not a revision.
- **Environment:** the candidate checkout as the working directory, with Nucleus's
  minimal hook environment. Installing dependencies is the repository's concern:
  the command must work in a fresh checkout (Tom, 2026-09-26).
- **Record:** the argv, its digest, exit code, duration, output tail, Nucleus
  build and settings revision are stored on the task and in the outcome row's
  `validation` field. The stored tail is the durable finding a refusal carries:
  when the executor's `maxOutputBytes` cap cut a stream, it keeps a bounded
  beginning and end around the marker and counts inside the same 2,000-character
  bound, so a long failure's beginning is not lost at this last step (Task #388).
  Queue records the verdict before removing the disposable candidate. A service
  roll before that write leaves the candidate for result reconciliation; a roll
  during cleanup keeps the verdict and retries forced removal on the next pass.
- A project with no validation command merges on independent review and GitHub's
  merge checks, as today. Per-task validation stays opt-in: the setting defaults
  to null and no default command is ever stored there.

## Milestone QA

[Milestone QA](../contracts/milestone-qa.md) owns the report-only task workflow,
legacy history and the compatibility-build handoff. The repository's `QA`
setting (`qa.argv` or `qa.stages`) identifies non-Effigy validation evidence
in task worktrees. The merge-time command continues to use `validation`.

## Acceptance oracle

g01.053:

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | No manifest, no project override | Nucleus closeout: no closeout run, workspace, hook or commit; outcome row written |
| 2 | No manifest, project `closeout: agent` | Agent closeout exactly as today |
| 3 | v1–v4 manifest, with or without a project override | Unchanged; the manifest governs |
| 4 | v5 manifest | Unchanged Nucleus closeout |
| 5 | Brief submission to a repository with no manifest | Accepted, as before |
| 6 | `repository.set`, `repository.get`, `repositories` | Round-trip; repository identity matches outcomes, lanes and numbers; survives restart |
| 7 | Default switch while a no-manifest task is mid-closeout | A closeout already running under agent authority settles under it; later closeouts use the new default |
| 8 | Brief capture while the shared checkout is behind origin | Planning commit and manifest eligibility come from the fetched `origin/<base>` head |

g01.054:

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Command exits 0 | Merge proceeds; result recorded on the task and in the outcome row |
| 2 | Command exits non-zero | One semantic revision round with the output tail as the finding |
| 3 | Timeout, launch failure, or the candidate left changed | Operational hold; no revision round spent |
| 4 | Base or head moved during validation | Stale result discarded; rerun on the fresh candidate |
| 5 | No command set | Merge on review and GitHub's checks, unchanged |
| 6 | v1–v4 manifest repository with a command set | Command ignored; manifest hooks govern |
| 7 | Command changed between runs | Each run records the argv digest it used |
| 8 | Nucleus build or settings revision changed | An ordinary settled result is discarded and validation reruns; a lost or timed-out run remains held for explicit retry |
| 9 | Same command, build and settings revision | Settled result reused; the command does not run again |

## Out of scope

Board editing of project settings, per-branch settings, secrets for validation
commands, dependency installation, and removing v1–v4 manifest support.
