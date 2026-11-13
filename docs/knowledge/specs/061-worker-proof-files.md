# 061 — Worker proof files reach the retained reviewer

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-11-12
Decision: papercut 01e88ba5, approved 2026-11-12 — a worker's visual proof belongs
with the reviewer, not on the public PR.
Governing refs: [Spec 054](054-required-proof-admission.md) (required proof),
[Spec 057](057-retained-change-review.md) (one retained reviewer per head),
[orchestration contract](../contracts/orchestration.md) (publication rules).

## Problem

A brief that asked for before-and-after dark-theme screenshots could not deliver
them. The worker rendered them into its own scratch and, correctly, kept them off
the public PR because they showed live board data. It reported their hashes and
pixel-difference figures and said the images went to the reviewer through
Nucleus; nothing carried them. The reviewer's scratch had none, so it judged the
required proof insufficient twice at the same head and the task parked at
`awaiting_proof` until the planner found the files and judged them by hand.

## Design

### 1. The report names its proof files

A worker or revision report may carry `proofFiles: [{label, path}]`. `label` is
a short description, `path` is the file's absolute local path. The report schema
(`shared/schema/review.ts`) and the `nucleus_report` bridge
(`bin/mcp-report.mjs`) apply one shape rule from
`shared/service/proof-files.mjs`: at most 12 entries, a label of at most 120
characters, a path of at most 1024 characters, and a harmless duplicate entry
de-duplicated. The callback helper forwards the field through the authenticated
run ticket like every other result field. A report carrying proof files must
also name its top-level `head`: the exact current pushed PR head. A revision
must report the head it now pushed, not the head its run started at; the bridge
does not infer this value.

### 2. Nucleus proves and copies each file

`core/intake/proof-files.ts` validates the whole list before it writes anything:

- the report names one exact 40-character head and it matches the verified
  pushed PR head;
- the task records a scratch directory for its author run;
- every path is normalized and absolute, is its own real path (no symlink in any
  component), is a regular file, and lies inside the task's record of its own
  worktree or scratch directory;
- each file is at most 8 MiB and the set at most 32 MiB.

An absent or mismatched head is refused before any copy. Only after the full
head and file list are validated does Nucleus copy each file into
`<task scratch root>/evidence/<task id>/<head>/<ordinal>-<sha8>-<name>` with mode
0600, and record `{head, label, name, path, sha256, bytes, runId, eventId, at}`
on the task. A refused entry copies nothing. The task's local source paths never
enter the stored completion; only the copies, their hashes and their labels do.

Evidence is appended to `task.proofFiles` through `Store.appendProofFiles`,
which de-duplicates the same bytes delivered again for the same head. The
ordinary retention pass removes a purged task's evidence by its recorded copy
paths, and only when every level still proves a real directory on its own
storage; an absent volume leaves it untouched.

### 3. The reviewer and the board read the evidence

The retained reviewer's prompt lists files recorded for the exact head under
review, plus files recorded by the latest author proof delivery for this task.
Each entry includes its recorded head, label, local path, SHA-256, byte count
and delivering run, so an earlier-head record stays honestly labelled and is
never relabelled as evidence delivered for the current head. The reviewer opens
the copies from its own session; they are never uploaded. The board's task
detail lists the same records under `Proof files` for the operator and planner.

### 4. Publication rules are unchanged

Nothing about this evidence is uploaded to the forge, and no local path enters a
PR body or comment. A PR may state that evidence was delivered to the retained
reviewer and give the hashes. The ordinary reviewer publication body carries
only reviewer findings, the verdict table and the authenticated marker.

## Acceptance

1. A revision starting at head A reports head B with two image files; the report
   head is checked against the pushed PR head, both files are recorded under B,
   and the reviewer prompt at B lists them with matching hashes.
2. Files recorded under A by the latest author proof delivery remain under A
   and appear in the B reviewer prompt labelled with recorded head A.
3. A missing or mismatched report head and a path outside the task's own scratch
   and worktree are refused with a clear message, and nothing is copied.
4. No local path reaches anything published to the forge.
