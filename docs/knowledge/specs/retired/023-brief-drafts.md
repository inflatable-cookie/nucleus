# 023 — Brief drafts

Status: retired (Tom, 2026-09-27); brief drafts folded into leads, [Spec 026](../026-planning-records.md)
Owner: Queue runtime and UI maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: [Spec 020 briefs](../020-briefs-stored-in-queue.md),
[Spec 019 lanes](../019-lanes.md), [Spec 021 task numbers](../021-task-numbers.md),
[Spec 012 durable operations](../012-durable-asynchronous-operations.md).
Nucleus ports the semantics once Queue has proven them (nucleus
`docs/triage/*-brief-drafting-surface.md`).

## Problem

Lean planners draft briefs as loose files, dry-run them with `northstar-submit`
and type the `queue_approval` line themselves. A draft has no home, the operator
cannot see it before approval, and approval is not tied to a version. Tom's
direction: a brief is its own record from initiation, and is promoted to a task
when ready.

## Draft record

A `brief_drafts` table, host-neutral:

| Field | Content |
| --- | --- |
| `id` | Queue identity |
| `repository` | Normalised origin plus local path hint (the identity used by outcomes, lanes and numbers) |
| `lane` | Optional lane key; the lane must list the repository, as at submission |
| `title` | From the latest version's frontmatter |
| `versions` | Ordered list: version number, text, digest, author, createdAt, and the check result for that version |
| `approval` | Null, or the approved version, its digest, who approved it, when, and a note |
| `status` | `draft`, `approved` or `promoted` |

- **Author** is the calling agent's id, or `operator` for a board action.
- **Every version is checked** when it is written, by the existing brief dry run:
  frontmatter, `queue:` routing (lane, dependencies, profiles), eligibility at the
  pushed integration head, and digest. Failed checks are stored with the version.
  A version that fails its checks can be kept, but not approved.
- **Drafts are never numbered.** The task number is assigned at promotion, when
  the task is created (Spec 021).

## Approval

- An operator action approves one exact version, named by version and digest,
  and only the latest one. Writing a new version clears any earlier approval.
- The approval is recorded provenance bound to that digest. It replaces the typed
  `queue_approval` line, which a draft-promoted brief does not need.
- The board's Approve action records `operator (board)`. A CLI approval records
  the calling agent and requires a note naming the operator's authorization, the
  same standard the typed line had. It is visibly marked as relayed.
- One approval covers one draft. Batch approval is a question for after the
  pilot.

## Promotion

- Promotion is one durable operation with a key derived from the draft id and the
  approved digest. It admits the task through the existing brief submission path,
  with the approved text, digest, lane and approval provenance. In the same
  transaction it records the task on the draft and deletes the draft's text.
- It is idempotent. A retry or a lost response returns the same task, and unknown
  delivery never creates a second task.
- The task keeps the approval provenance and the digests of the draft's earlier
  versions, and the outcome row carries them. `amend_brief` lineage continues from
  the promoted version. The draft row remains only as a tombstone (id, task id,
  digests) so a promotion can always be traced.
- Only an approved draft whose approved version is the latest can be promoted.
- **Checks re-run at promotion.** A version's stored result can go stale if the
  planning commit, manifest, lane or dependencies change between approval and
  promotion. Promotion re-runs the full dry run against the pushed integration
  head before admitting anything, and refuses on failure. A refusal leaves the
  draft and its approval intact, records the fresh result against the version, and
  can never leave a task half admitted: the checks finish before admission starts,
  and admission is the single transaction that creates the task and records the
  promotion. The idempotence key stays the draft id plus the approved digest.
  (Pinned at the Nucleus Chatterbox's request, 2026-09-26.)

## Surfaces

- **RPC and CLI:** `draft.create`, `draft.edit`, `draft.get`, `draft.list`,
  `draft.approve`, `draft.promote`, `draft.delete`. Planners write drafts through
  Queue instead of the filesystem. The Queue skill documents the flow.
- **Board:** a Drafts view alongside Status and Lanes, filtered by the project
  filter. Each draft shows title, lane, version, author, check result and approval
  state. Opening a draft shows its full text and version history, with Edit,
  Approve and Delete.
- **Board editing** (added by Tom, 2026-09-26): Edit opens the latest version's
  full text, frontmatter included, in a plain monospace text area in the existing
  dark-theme styling. Save writes a new version authored `operator (board)`. It
  runs the same checks and clears any approval, exactly like an edit through the
  CLI. Cancel discards the edit. A save against a version that is no longer the
  latest is refused with a prompt to reload, so two editors cannot overwrite each
  other.

## Field ownership

Queue owns `title`, the `queue:` routing (lane, dependencies, scope, complexity,
profiles, notifications) and the approval record. The body is opaque to Queue; its
sections are Northstar's convention.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Create and edit a draft | Each edit is a new version with author and digest; checks recorded per version |
| 2 | A version that fails checks | Kept and visible; cannot be approved |
| 3 | Approve the latest version; then edit | Approval bound to that digest; the edit clears it |
| 4 | Approve a stale version or a wrong digest | Refused |
| 5 | Promote an approved draft | One task with the approved text, digest, lane and approval provenance; draft text deleted; tombstone kept |
| 6 | Promotion retried, or response lost | Same task; never a second one |
| 7 | Promote an unapproved draft | Refused |
| 7a | Promote after the pushed head, manifest, lane or dependencies changed so the approved version now fails its checks | Refused; no task created; draft and approval intact; the fresh result recorded on the version |
| 8 | Task after promotion | Carries earlier version digests; outcome row keeps them; `amend_brief` works from the promoted version |
| 9 | Lane on a draft | Validated like submission; carried to the task |
| 10 | CLI approval | Records the agent and requires an authorization note; marked relayed |
| 11 | Board Drafts view in dark theme at both viewport sizes | Lists drafts per project; Edit, Approve and Delete work; Status and Lanes views unchanged |
| 11a | Board edit saved; saved against a superseded version | New version authored `operator (board)`, checked, approval cleared; a stale save refused with a reload prompt |
| 12 | Restart and migration | Drafts and approvals survive; old stores migrate with none |

## Out of scope

Rich-text or syntax-aware editing, batch approval, draft templates, drafts for handoff mode, and
cross-repository drafts.
