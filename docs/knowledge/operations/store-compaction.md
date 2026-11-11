# Compact the Nucleus store

Owns the operator and root procedure for the one-shot conversion of a pre-change
store to incremental auto-vacuum, and for reading what the bounded maintenance
did. The behaviour is Spec [028](../specs/028-store-backups.md#delivered-how-the-store-compacts-audit-b9);
this page is the runbook.

The data directory is `~/.nucleus`, or `NUCLEUS_DATA_HOME` when set, and
the store is `queue.sqlite` in it.

## What happens without anyone acting

- **New stores** open in incremental auto-vacuum, and their freed pages are
  returned by the bounded maintenance passes: after the hourly history prune and
  the daily purge, and on every engine maintenance tick while free pages exceed
  the drain threshold (task 989). Nothing to do.
- **A store created before this change** says `auto_vacuum=0`. The service
  converts it **once**, at start, before it serves anything. The attempt takes one
  verified snapshot through `backup.now`, checks the store and the free space,
  and rewrites the file if everything passes. Until it lands, the store cannot
  give freed pages back — bounded maintenance reports that instead of pretending.
- A store's own record is one meta row, readable without writing anything:

  ```sh
  sqlite3 -readonly "$data_dir/queue.sqlite" "select value from meta where key='storeCompaction'"
  sqlite3 -readonly "$data_dir/queue.sqlite" "select value from meta where key='storeMaintenance'"
  ```

  `state` is one of five facts, and they are not interchangeable:

  - `converted` — the rewrite landed **and** the canonical content of every
    authoritative row and setting was verified identical. This is the only state
    that means the conversion is done and the records came through.
  - `landed` — the rewrite is in the store (`auto_vacuum=2`) but preservation was
    never positively verified: the attempt died before the check, the check found a
    difference, or a later start settled it from the store's mode alone. The store
    is usable and its records are **not** proven unchanged. This is final; nothing
    rewrites an incremental store to clean up its health.
  - `refused` — a precondition or the quiet window failed before anything was
    touched; the store holds exactly what it held.
  - `failed` — an attempt failed and the rewrite did not land; the store still
    reads `auto_vacuum=0` and holds the rows it held.
  - `running` — an attempt whose process died before it could record the outcome;
    the next start settles it from the store itself.

  `reason` says why, `before` and `after` are the file and page facts, `snapshot`
  names the verified snapshot a restore would use, `fingerprint` is the canonical
  content digest the rewrite started from, `verification` says what the
  post-rewrite check found (`verified`, `changed` or `not-run`, with rows, bytes
  and time), `exclusion` records the window's own proof (journal mode, retained
  exclusive lock, and the refused probe before and after the rewrite), `prior`
  keeps the dead attempt's evidence when a later start settled it, and
  `blockedMs` is the measured window beside its `estimatedBlockedMs`.

## What the store keeps (schema 55)

Lean store 2 (task 987; Tom, 2026-11-09: "30 days / latest 50") bounds the rows
that outlive their task or run. The schema-52 step applies these on open of a
schema-51 store, behind the pre-migration snapshot; the daily purge applies the same
rules after that. Each rule keeps what a live row, an unsettled intent or an outcome
still needs.

- **Finished operations** (`succeeded`, `failed`) of a purged task: 30 days after they
  settled. Pending, running and needs-attention operations stay.
- **Check-policy observations** (`checkPolicyObservation:<task>`): removed with their task.
- **Project and lane notices and events** that are settled (`delivered`, `superseded`
  notices; and every project or lane event): 30 days. A notice's age is the ISO stamp its id ends with.
- **QA schedule merges**: only for a repository that has a schedule. An unscheduled
  repository's backlog is deleted.
- **Host runs**: the latest 50 settled per selector. Unsettled runs stay, and so does a
  settled run whose accounting retirement is inside the four-day history window. A
  pruned run takes its identity, CPU and disposition sidecars and its retained-output
  failure.
- **QA runs**: the latest 50 per repository, plus active runs, the run a status row
  names, and the latest passing main run of each repository.
- **Retained-output failures** for a run settled past the four-day history window
  settle; they are not retried.
- **Assignment history**: the latest 50, which is what the profile picker reads.
- **Outcomes and leads** are kept forever. Schema 55 stores outcome search text in
  the outcome only, shared lead bodies in the current version, shared task text in
  brief versions and shared review findings in run completions. Different bytes
  stay independently stored. The migration follows the verified backup.
- **Retired row fields and events** (schema 54, task 989): the outcome
  `routing.capability` spelling is rewritten to `scope` once, `outcomes.stageRuns`,
  `extraReplacements`, `resolution.mechanicalReviewCarry` and `.authorEscalations`,
  the write-only run `reviewScopeDigest` and `formalReviewerLogin` and the QA run
  `queueCapacityDeadlineAt` are stripped, and the unread `workspace_creation_step_*`
  events are deleted. The strip runs on every open, so a row a rolled-back build
  wrote is cleaned the same way. What was kept of the removed values:
  `outcomes.stageRuns` is archived at `outcomes-stageRuns.json` in the operator’s external `nucleus-inert-history-2026-11-09` archive
  (manifest beside the directory); the grant, carry and escalation fields held only
  their empty defaults; the write-only run and QA fields and `reviewScopeDigest`
  are not archived — their pre-strip bytes remain in the migration's verified
  pre-migration snapshot and the store's own backups, and the planner completes
  the external archive of the removed values before roll.

Freed pages come back through the bounded pass above. `storeMaintenance` records the
last release that returned pages; `storeMaintenanceError` records the last one that failed.

## The activation boundary

The code is the boundary; the ruling is the operator's. This runbook does not
authorize anything on its own.

- **The conversion is service code, never a command.** Do not run `sqlite3`
  `VACUUM`, `PRAGMA auto_vacuum` or any other write against the live store, and do
  not open the live file with a second writable connection. `VACUUM` outside the
  service's window is exactly the ad-hoc edit the ruling forbids.
- **The worker and reviewer of the change** prove it on isolated fixtures only.
  The bench receipt is `evidence/store-compaction-20261025.json` in Git history; it measures a
  fixture store built to the audit's populations, not the live database.
- **The root owns the live step**: the quiet window (a service start during a
  pause in dispatch is the usual choice), the free-space check against the
  numbers in the record, and a look at the newest verified snapshot. Then a
  healthy deploy of this build is the activation: the next service start makes
  the one attempt. No operator pause needs changing — the conversion never reads
  or writes the operator's pause state, and a paused board stays paused.
- **What the window costs.** The rewrite is one synchronous step in the service
  process: the service is not ready while it runs, and reads and heartbeats wait.
  It is bounded before it starts (the estimate covers the rewrite, both integrity
  checks and both canonical content passes, and must fit 120 s) and it is measured
  after. At the live store's measured size (1.05 GB) the estimate is 109.2 s; the
  fixture bench measured a median 8.7 s for a 345 MB store, 1.8 s of it the content
  verification. Choose a window you would accept losing for that long, and expect
  the host-run endpoint and callbacks to appear only after it finishes. The roll
  that spawns the service waits out that same bounded window before it decides
  anything about the replacement, so a conversion is never mistaken for a hung
  start.
- **Space.** The rewrite needs the old file and the new one at once, plus the WAL,
  the snapshot it just wrote and 256 MiB of headroom. The record's
  `requiredFreeBytes` is computed from the real file and the snapshot it took; a
  store without that room is refused before anything is touched.

## If the record says `refused`, `failed` or `landed`

Nothing was lost in a refusal or a failure: a refusal happens before the file is
touched, and a failure leaves the original store openable. A `landed` record is
different: the rewrite is in the store and only preservation is unproven. Read
`state` and then `reason`.

- **`insufficient free space ...`** — make room on the volume and restart the
  service; a refusing attempt may retry after an hour, and at most three times in
  total. Do not delete snapshots to make room: the pre-conversion snapshot is the
  recovery route.
- **`the estimated blocked interval ... exceeds ...`** — the store is too large
  for a 120 s window on this host. Leave it; the store keeps working exactly as it
  did before (freed pages stay in the file), and that is a deliberate refusal, not
  a fault.
- **`still active` / `locked` / `refused exclusive access`** — something else held
  the store (usually a backup child or another reader) or the window could not
  take the file exclusively. The record says `refused` and the store was not rewritten.
  Retry by restarting the service when it is not running; the attempt is bounded
  and the store is unchanged.
- **`the store's logical content changed across the rewrite`** — the rewrite
  landed and the canonical check found a difference, so the record says `landed`
  and names the rows and bytes it saw. Its `exclusion` field records whether the
  window held the file exclusively and whether a competing connection was refused
  before and after the rewrite: if those are all true, look for a writer that
  shares the data directory outside the service (which the service-boundary
  contract forbids) rather than for a bad check. The store is usable and its
  records are not proven unchanged; do not describe it as unchanged and do not run
  a second `VACUUM`.
- **`the bounded attempt count is spent`** — three attempts did not convert the
  store. The store stays on its old mode and keeps working. Report it; a fourth
  attempt needs a code or host decision, not a manual `VACUUM`.

A `landed` record is the honest end state of a rewrite that could not be proven:
the conversion did its job, and the records are not proven unchanged. Nothing is
retried, and the record keeps the dead attempt's evidence (`prior`, `fingerprint`,
`snapshot`, `verification`). If you need a proven copy of the records as they were,
read the snapshot the record names; a restore is a separate, root-owned decision.

If the store itself does not open after a failed attempt (it should — the record
says what failed, and a rewrite that did not land leaves the file as it was),
restore the snapshot the record names: [restore.md](restore.md). A restore uses
the pre-conversion snapshot, so it loses only the writes after that snapshot.

## Cadence that stays as it is

The 6-hourly snapshot interval, the pre-migration snapshot, the 24/14/8 rotation
in the one backup directory and the verified-snapshot health on the board are
unchanged by this change (Spec 028). The bounded freed-page pass runs after the
existing hourly and daily prunes, and — task 989 — on every engine maintenance
tick while free pages exceed the drain threshold; it adds no new schedule of its
own beyond the sweep that already exists.
