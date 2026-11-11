# 028 — Store backups

Current stores use schema 58. Schema 50 evolves atomically after a native
SQLite admission check and a pre-migration backup; schema 49 and older are
refused with the schema 50 minimum named, and require an older build. Unsupported
and unversioned stores refuse before application schema or data writes, chmod,
backup, or cleanup. SQLite may create or update its normal coordination files
during the native read and lock. A schema 50 upgrade creates its private snapshot
through the admitted SQLite connection, then reacquires the write transaction and
compares stored rows and their order before publishing a verified backup. The
schema 51 step drops retired `brief_drafts` and `shadow_stream` storage,
removes the redundant run identity indexes and null or retired meta entries, and
marks the completed host-selection migration. Schema 52 applies the retention
windows for rows that outlive their task or run (task 987). Schema 54 (task 989)
strips the retired row fields — the outcome `routing.capability` spelling is
rewritten to `scope` once, `outcomes.stageRuns`, `extraReplacements`,
`resolution.mechanicalReviewCarry` and `.authorEscalations`, the write-only run
`reviewScopeDigest` and `formalReviewerLogin`, and the QA run
`queueCapacityDeadlineAt` — and deletes the unread `workspace_creation_step_*`
events. The strip runs on every open, idempotently, so the one-time backlog and
any row a rolled-back older build wrote are one rule set (about 190 ms scanned on
a clean store at the live store's size). The legacy read-side rewrites
(`outcomeRecordFromLegacy`, `readTaskRecord`'s single-lane shape) went with the
step: stored rows are today's shape. The backup worker rechecks the inherited source
file identity before managed publication; SQLite locks do not prevent filesystem
renames. If the source is replaced after publication begins, startup refuses;
the attempt may leave its new directory, staging files or a verified snapshot of
the admitted source. Existing backups, status and unrelated interrupted files
are preserved. Routine backup runs handle retention and interrupted-file cleanup.
A missing backup volume still permits migration; its outage status is recorded
only after successful admission, so a refused replacement cannot overwrite it.
See the [restore runbook](../operations/restore.md) for preflighting a backup
before replacing managed files.

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-09-27
Decision owner: Tom
Governing refs: [Spec 013](013-standalone-queue-service.md) (the service owns the
store), [release contract](../contracts/release.md) (never edit the live database)

## Problem

Nucleus's store now holds the permanent record: outcomes, papercuts, leads, lane
documents, plans, projects and settings. It had no backup of its own. Time
Machine copies the live database and its write-ahead log at different moments, so a
restore is not guaranteed consistent, and its disk is only occasionally connected.

## Snapshots

- **Consistent:** the service writes each snapshot with SQLite `VACUUM INTO` into
  the backup directory (see [Where backups live](#where-backups-live)). That is a
  transactionally consistent copy made without pausing Nucleus or holding the
  executor.
- **When:** every 6 hours, before every schema migration, and on demand
  (`backup.now`). The schedule is due against the newest verified snapshot, not
  the service's lifetime: a cheap check (it only lists the backups directory) runs
  at start and every 15 minutes, and takes a snapshot once the newest is 6 hours
  old, so frequent rolls never postpone one. A failed snapshot is retried no
  sooner than an hour later. A service start takes no snapshot unless one is due:
  Nucleus rolls on every merge, and a snapshot on every start doubled the write load
  on the internal SSD (Tom, 2026-10-20, relayed by the Project-c Supervisor: "Yes to all your suggestions. We could go to 6 hourly, and manual backup on schema change? Reduce retention to 4 days"; the pre-migration snapshot stays as the schema-change backup).
- **Verified:** each snapshot is opened read-only and passes `PRAGMA
  integrity_check` before it counts; it is then compressed as a stream and read
  back through a streaming decompressor whose digest must match the verified
  bytes before the file is published. A failed snapshot is deleted and reported,
  never kept as a restore point.
- **Rotation:** 24 scheduled (`hourly`-named), 14 daily and 8 weekly are kept in
  the backup directory. A daily or weekly snapshot is a hard link to the verified
  scheduled file it came from, so it costs no second write; a volume that refuses
  links falls back to a copy. Rotation only ever touches that one directory.
- **Visible:** `backup.list` returns the retained snapshots with their time, size
  and verification, `manual` on a snapshot taken by Back up now (recorded by file
  stem in the status file beside the store and pruned with rotation), the backup
  directory and the retention counts. The service reads that listing in its own process; it spawns
  no child to stat the directory. The board projection also carries snapshot
  health (the newest verified scheduled snapshot and the last failure), so the
  warning below needs no listing of its own. The Settings
  screen's Backups tab (Tom,
  2026-09-27) lists the stored snapshots newest first, one row per file with its
  tiers as labels, under a line naming the newest verified age and the next due
  time, with Back up now (nucleus#965). Problems read as one warning line; the
  folder, schedule, retention and the restore runbook sit behind its `?`, and it
  has no restore action. Its listing poll runs only on that tab. A
  newest snapshot older than seven hours (one interval plus an hour), or a failing location, also shows a warning
  on every other Settings tab, with a link to Backups, read from the board's
  snapshot health.
  Time Machine is a separate concern.

## Where backups live

The `workRoot` setting owns the backup location (Tom, 2026-11-10;
[service boundary](../contracts/service-boundary.md#process-and-data-ownership)).
Fresh installs use the portable data-home placement. Existing installs adopt
and persist the common mount derived from their records, with no data move.

- **Pinned volumes stay guarded.** A pinned or adopted external volume
  must be present and writable before a snapshot can create directories. An
  absent mount is never recreated as an internal directory, and no snapshot
  falls back to another disk. Private data-home fixtures keep their own backups.
- **Retired paths remain history.** Nucleus never probes or prunes old volumes
  outside its active placement. Restoring an archived snapshot is an explicit
  operator action.
- **A failure is durable and visible, and never blocks Nucleus.** The status file
  moved out of the backup directory to `<data dir>/backup-status.json`, beside the
  store: the absent volume is exactly the failure it has to report, so it cannot
  be where the report lives. A refused snapshot writes nothing, records the
  reason there, and the existing due check retries it (at the next 15-minute
  check, or an hour after a failure) with no new retry machinery. `backup.list`
  and the board report the current volume state and the recorded failure. An
  absent new-work volume cannot supply its own snapshots, so every Settings surface names the
  outage — the warning on the other tabs and the Backups tab both read the
  failure, never "No verified backup yet", which would describe waiting for a
  first snapshot rather than a drive that is away.
- **A migration survives the outage.** A pre-migration snapshot that fails on a
  volume that is there still stops the migration, as it always has. A snapshot
  that could not be attempted because the volume is away is recorded and the
  migration proceeds: Nucleus must never hold its own start on a drive. The store's
  schema steps are unchanged and the record says no pre-migration snapshot was
  written.
- **Scoped to the live store** (2026-10-04: test runs wrote into the live folder
  and pruned its real backups): the external directory applies only to the live
  data directory (`~/.nucleus`, compared by real path, in a process whose `HOME`
  is the account's own home), independently of `NUCLEUS_DATA_HOME`. A private
  `NUCLEUS_DATA_HOME` with the normal account `HOME` is still a private instance.
  Any other data directory — one chosen through `NUCLEUS_DATA_HOME`, a fixture, a
  throwaway `HOME` — keeps its snapshots in `<data dir>/backups/`, and the backup
  worker refuses to write to or prune the live directory for any other source
  store.

Snapshots contain task text, briefs, papercuts and credential hashes, never
plaintext secrets.

### Delivered: what moved, and what went away

- The backup directory stopped being a relative idea. `backupDirForDataDir`
  (`core/store/backup-worker.mjs`) is the one rule: the selected external path for the live
  store, `<data dir>/backups/` for anything else, and the service, the store's
  pre-migration snapshot and the children all take it from there. The
  `backupTargetDir` runtime option and the second "off-machine" directory are
  gone, so nothing can configure Nucleus's snapshots into a second place.
- `backup.list` entries no longer carry a `location` (`local`/`offMachine`); the retired Builds directory is no longer listed or probed, and
  `backup.list`, `backup.now` and the board's `backup` no longer carry
  `offMachineError`: there is one write location and one failure. Settings shows the
  error once, labelled `Backups:`.
- The status file moved from `<backup dir>/status.json` to
  `<data dir>/backup-status.json`. A status file inside the backup directory
  could not report the one failure that matters most, and a volume that goes away
  takes it with the snapshots.
- The mount check lives in `assertBackupVolume` and applies to any backup
  directory named by a path under `/Volumes`. A volume root that is missing, is
  not a directory, or is on the same device as its parent is refused before
  `mkdir` runs.
- The worker's exit code separates the two cases a pre-migration snapshot can
  hit: `2` is the backup volume being away (the migration proceeds with the
  outage recorded), anything else is a snapshot that failed (the migration still
  waits for the snapshot it could have had).

## Revision: a streamed, self-verifying snapshot (2026-10-25)

Tom (2026-10-25, performance audit items A8 and B4), on the same ruling as the
revision below.

- A snapshot is compressed as a stream, in one bounded read chunk: the whole raw
  copy and its whole compressed form are never held in memory together. On a
  throwaway copy of a verified live snapshot (1.05 GB store, 264 MB compressed)
  peak RSS fell from 1.53 GB to about 100 MB over the process baseline, and the
  published file is byte-identical to the one the old path wrote (same gzip
  SHA-256, same decompressed snapshot SHA-256). The bench receipt is
  `evidence/backup-streaming-bench-20261025.json` in Git history.
- Each compressed snapshot is read back through a streaming decompressor and its
  digest must equal the digest of the bytes `PRAGMA integrity_check` passed, or
  the temp file is deleted and the run fails with the reason recorded in the
  backups status. That costs one extra read of the compressed file per snapshot
  (about 16% of the snapshot's wall time in the bench) and it is what makes "a
  failed compression or a full disk publishes nothing" true rather than trusted.
- The codec stays gzip. A stronger compressor is allowed but not justified here:
  zstd would need new codec and version metadata, a fail-closed availability
  check and a restore path that reads two formats, for a saving the storage
  fixes already claim. Restore is unchanged — `gzip -dc`, `gunzipSync` and the
  existing runbook read a snapshot written by this build, and the snapshots
  already on disk keep reading as they did.
- `backup.list` is read in the service process. Spawning `node --import tsx` to
  stat the backups directory cost a Node start-up on every Settings poll.
- The worker's command line lives in `core/store/backup-cli.mjs`, separate from
  `core/store/backup-worker.mjs`, so the service can import the worker module for
  listing and health without a module import ever running a command. (An import
  through the TypeScript loader can load the module a second time, so a command
  block inside it could run twice.)
- The board projection carries snapshot health, and the revision advances once
  when it changes, so a poller holding a bounded acknowledgement re-projects
  instead of keeping the old fact. Settings polls `backup.list` only on the
  Backups tab; the warning on the other tabs reads the board.

The 6-hourly cadence, the 24/14/8 rotation, the hard link between a day's
verified snapshot and its daily and weekly entries, and the snapshot's
consistency (one `VACUUM INTO` from the live store) are unchanged. (That
revision still wrote a second, off-machine set; [Where backups
live](#where-backups-live) supersedes that and keeps the same counts in the one
directory.)

## Revision: lighter backups and a compacting store (2026-10-25)

Tom (2026-10-25, performance audit), choosing "Lead version storage", "Shrink the DB file", "Lighter backups" and "Slimmer task rows".

**Backups.** A snapshot is compressed as a stream, not by reading the whole file
into memory. A stronger compressor may be used. The 6-hourly cadence and the
rotation counts are unchanged.

**Store compaction.**
- The store moves to incremental auto-vacuum.
- That needs one full `VACUUM`, run by service code at a quiet moment with
  writers paused, after the storage fixes land. It is never an ad-hoc edit of
  the live file.
- Free pages are then returned after the hourly and daily prune passes.
- A bounded `journal_size_limit` and cache size are set.
- The pause and the free space the compaction needs are stated in the change,
  and a failed compaction leaves the store as it was.

### Delivered: how the store compacts (audit B9)

**A new store starts incremental.** The store opens with
`PRAGMA auto_vacuum=INCREMENTAL` on a file with no tables yet, so from this build
on a store can give freed pages back. Every open also sets
`PRAGMA journal_size_limit=67108864` and `PRAGMA cache_size=-65536` (64 MiB
WAL ceiling, 64 MiB page cache). These are per-connection settings in SQLite, so
they are applied on every open and change no stored row.

**An existing store is converted once, by the service, at start.** SQLite can
only change the auto-vacuum mode with one full `VACUUM`, which rewrites the whole
file. `core/store/store-compaction.ts` owns that one conversion:

- **When.** It runs only in the production service, at start, before the service
  binds its sockets or releases any work — the one window in which no Nucleus
  writer can be in flight. It comes after the store's schema steps, and refuses
  a store whose schema is not current. A timerless fixture or a fixture adapter
  does not attempt it (a fixture may opt in with its own snapshot route).
- **Intent before touch.** A durable record in Nucleus-internal meta
  (`storeCompaction`) is written with `running`, the pre-conversion file facts,
  the verified snapshot's name, the required space and the estimated blocked
  interval *before* the file is touched. A restart reads the store itself:
  `auto_vacuum=2` means the conversion landed, so it is never repeated; `0` means
  nothing was rewritten (`VACUUM` runs in its own transaction), so the bounded
  attempt may run again. A record that is not final is settled from the store
  whenever the service starts — including one whose rewrite already landed
  (`running`, `landed` or `failed` with `auto_vacuum=2`). At most three attempts, a
  refusing attempt may retry after an hour, and an exhausted budget is a recorded
  refusal rather than a silent loop. The revision below states what a settlement
  may and may not claim; the outcome vocabulary is
  `running`/`converted`/`landed`/`refused`/`failed`.
- **Recovery route and space first.** One verified snapshot through the operator's
  own `backup.now` route must exist, the store must pass `integrity_check`, there
  must be room for the rewrite (`2 x file + WAL + snapshot + 256 MiB headroom`) and
  the estimated blocked interval — rewrite, both integrity checks **and both
  canonical content passes** — must fit the 120 s bound
  (`COMPACTION_MAX_BLOCKED_MS`). Any of those failing
  records `refused` with its numbers and leaves the store exactly as it was. The
  runbook is [operations/store-compaction.md](../operations/store-compaction.md).
- **Every writer is out for the whole window, and the window proves it** (revision
  below). The store's write funnels are closed
  (`Store.beginMaintenanceWindow`) for the length of the window; that is
  service-local and never reads or writes the operator's `paused` key. Inside the
  window the conversion truncates the WAL, requires the checkpoint not to report
  `busy`, leaves WAL for a rollback journal (which needs exclusive access, so a
  live reader or writer anywhere refuses the window), and then takes SQLite's
  exclusive file lock and keeps it across the pragma, the `VACUUM` and the whole
  verification. A competing connection — in this process or another — is refused
  for that whole span, and a probe connection must be refused before and after the
  rewrite. `VACUUM` never runs inside an ordinary write transaction.
- **The result is verified from the rows** (revision below). The mode must read
  `2`, `integrity_check` must pass, and a canonical digest of every authoritative
  logical row and setting, taken inside the window before the rewrite, must equal
  the one taken after it. The measured blocked interval is recorded beside the
  estimate, the window's exclusion evidence is recorded with it, and the record
  names the snapshot a restore would use.
- **A failure is described as what it was.** A window that cannot be proved is
  `refused` before anything is touched. A rewrite that did not land is `failed`
  and is the only case allowed to say the store was not rewritten. A rewrite that
  landed without verification is `landed`: never `converted`, never described as
  leaving the store unchanged. In every case the store stays openable and keeps
  taking ordinary writes.

**Freed pages are returned by a bounded pass, on every maintenance tick while the
freelist is large.** `Store.reclaimFreedPages`
asks for at most 4,096 freed pages, in 256-page chunks, and stops after 1 s, so
it is a series of short write passes and not an unbounded writer stall. (Task 987:
the earlier 512-page chunks and 250 ms budget stopped after two chunks, so a prune's
freelist drained over a dozen hourly ticks.) It runs after the hourly history prune
and after the daily purge. Task 989: while free pages exceed 4,096, the 20-second
engine maintenance tick also runs one pass at 8,192 pages and a 2 s budget, so a
freelist the size of a prune's backlog drains in minutes — on a live-equivalent
snapshot copy, three ticks released 24,606 pages in 2.4 s, where the hourly-only
passes released about 6 pages a minute. At or below the threshold only the
prune-coupled passes release, and a pass that
finds nothing to reclaim writes nothing. Each pass ends by truncating the WAL to
the journal limit. A pass that fails records
`storeMaintenanceError` in meta, so a refused release is visible instead of silent. Incremental
maintenance returns pages a prune freed; only the one-shot rewrite returns pages a
store freed before it was incremental — the two are reported separately.

**What it measured** (`evidence/store-compaction-20261025.json` in Git history, SHA-256 in the
`.sha256` beside it; three independent isolated stores at the audit's populations,
344.6 MB each, `effigy test bench_store_compaction`). Pruning 22,722 pages left
the `auto_vacuum=0` file byte-identical; the one-shot conversion took it from
344.6 MB to 251.0 MB (27.15%) with a median blocked interval of 3,172 ms (3,143-3,763
ms across the three runs) against a 23,829 ms estimate (a floor from 24 MiB/s, and the live store's
1.05 GB estimates at 62,326 ms, inside the 120 s bound); the verified snapshot
that gates it was 105.4 MB; the next prune's 22,708 freed pages came back in one
58 ms bounded pass (251.0 MB to 157.9 MB), leaving the WAL at 4,152 bytes. Peak
RSS was 362.5 MB in a process that had already built the same store. This is a
fixture measurement, not a live CPU/RSS/DB probe: the live store's own conversion
is the operator's activation, with the root owning the quiet-window, disk and
backup review.

## Revision: every writer stays out, and the outcome says what happened (2026-10-25)

Tom (2026-10-25, on the first live attempt at the conversion), one ordinary
general correction under the approved 440/Spec 028 reliability authority.

The live attempt landed the rewrite and then reported a falsehood. The supervisor's
read-only record shows a 6,871 ms window whose documented estimate was 70,971 ms,
a verified snapshot, and a store that went from 1,207,418,880 bytes and 92,537
free pages at `auto_vacuum=0` to 815,861,760 bytes and 0 free pages at
`auto_vacuum=2`. The conversion landed. What did not hold up was the record
written beside it: the failure reason ended with "the original store is openable
and unchanged" after the rewrite had already replaced the file, and the check that
was supposed to prove preservation compared per-table row counts and stored
width, which cannot see a same-length edit inside a value. An exact-authority
journal row landed inside the window too, which is the second thing this
revision fixes: a momentary `BEGIN EXCLUSIVE`/`ROLLBACK` probe is not an exclusion
guarantee for a rewrite that takes seconds.

**Every writer is out, and that is proved rather than inferred.** The store's own
writable connection is the executor thread (`service/executor/executor-worker.ts`);
the prewarm standby reads file bytes; the schema probe opens read-only; the backup child reads; and a second service instance fails closed on the live
`processOwner` lease. The window now handles the remaining case — a connection
that reaches the file anyway — by taking the file itself: it leaves WAL for a
rollback journal (a change that needs exclusive access, so any live reader or
writer refuses the window before the pragma), then sets SQLite's exclusive
locking mode and takes one write transaction, which retains the exclusive OS file
lock for the connection. From that moment until the restore at the end of the
window, a competing connection in this process or another is refused outright,
through the `VACUUM` and through verification. Two instrumented probes, one
before and one after the rewrite, open a second connection and require its write
lock to be refused, and the record carries the answer as `exclusion`
(`journalMode`, `exclusive`, `probeBefore`, `probeAfter`). A window that cannot be
proved refuses before anything is touched and leaves the service usable: no busy
wait, no forced kill, no partial quiescence. The journal mode is restored in a
`finally`, so a failure at any step leaves the service's own connection working
in the mode every open sets.

**Preservation is verified from the rows.** `Store.contentFingerprint()` hashes
every column value of every authoritative table from its exact stored bytes, and
combines one table's rows as a count plus a 64-bit sum and xor, so the digest does
not depend on row order or rowid but does depend on content and multiplicity.
SQLite's `sqlite_*` bookkeeping, FTS5's shadow tables (whose page and segment
layout is the index's representation of the text the virtual table returns) and
this module's own two `meta` records are excluded, each for that stated reason,
and the FTS virtual table's logical rows are hashed instead. Every other table and
every other `meta` row — pause, limits, pool, availability, usage, retention
marks, host-run and shadow journals, history — is hashed exactly, so a
same-length edit inside a value fails verification and a landed rewrite is never
called unchanged. The digest is taken and recorded *inside* the exclusively held
window, before the pragma and the `VACUUM`, so the record names the state the
rewrite started from even if the process dies during it.

**The outcome distinguishes three cases, and a settlement keeps the evidence.**
`converted` means the rewrite landed *and* the content verified. `landed` means
the rewrite is in the store but preservation was not positively verified — the
attempt died before verification, verification found a difference, or a later
start settled it from the mode alone — and it is final, because an incremental
store is never rewritten again to clean up its health. `refused`/`failed` mean
nothing was rewritten, and only those may say so. Settling a dead attempt records
`landed` (never `converted`), keeps the previous attempt's state, reason,
snapshot, digest and measured window in `prior`, and states that the mode proves
the conversion and not that the records are unchanged. Content written after a
landed rewrite is ordinary work, so no later start re-verifies it and no mode
alone mints a verified success.

**The roll waits out the window it admitted.** The one-shot conversion is capped
at 120 s and the snapshot that gates it comes first, so a service start can now
spend up to 180 s before it serves (`MAINTENANCE_READINESS_CAP_MS`). The start
records that bounded window in the same durable, pid-and-spawn-token-scoped marker
family as a store migration (`service/install/standby.ts`), and both the bridge's
readiness wait and the executor's boot bound count it — the migration and the
maintenance window once each. A roll therefore waits for a conversion it
authorised instead of calling the replacement hung and spawning beside it, and a
marker another spawn left behind never extends a later process. No global timeout,
breaker or readiness cap was raised.

**What it measured** (`evidence/store-compaction-20261025.json` in Git history, SHA-256 in the
`.sha256` beside it; three independent isolated stores at the audit's populations,
344,641,536 bytes each, `effigy test bench_store_compaction`, host load average
40.7-46.8): pruning 22,722 pages left the `auto_vacuum=0` file byte-identical; the
one-shot conversion took it to 251,076,608 bytes (27.15% smaller) with a median
blocked window of 8,652 ms (6,624-8,652 ms across the three runs) against a
39,238 ms estimate that now includes the verification; the canonical content pass
over 70,218 rows and 390,179,720 bytes of stored content measured 957 ms before
and 836 ms after the rewrite (213 KiB of content per ms, against the 64 MiB/s
floor the estimate uses, three times below the slowest pass); the verified
snapshot that gates it was 105,377,495 bytes; the next prune's 22,708 freed pages
came back in one 122 ms bounded pass (to 157,954,048 bytes); peak RSS was
478.44 MB in a process that had already built the same store. The live store's
measured 1,049,186,304 bytes estimates at 109,228 ms, inside the 120 s bound. This
is a fixture measurement, not a live CPU/RSS/DB probe; the live store's conversion
has already landed, and a later physical re-measure belongs to the root with the
Supervisor.

**Unchanged.** Task identity, callback authentication, exact-head review and merge
gates, provider independence, durable side-effect intent, unknown-delivery and
custody semantics, holds, retention, profiles, limits, subscriptions, the
operator's pause state and every stored record, contract 010 host-run history
included, are untouched: the digest covers them and the window never reads or
writes the pause key.

## Restore

`docs/knowledge/operations/restore.md` is the runbook. The plugin is disabled so
the service stops. The current file set is moved aside, never deleted. A verified
snapshot is decompressed into place, and the plugin is re-enabled and reloaded.
Nothing writes to the live database while the service runs. The store's one-shot
conversion and the bounded freed-page maintenance have their own runbook:
[operations/store-compaction.md](../operations/store-compaction.md).

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Snapshot while tasks change the store | Snapshot opens, passes integrity_check, and matches a single committed state |
| 2 | Schema migration | A verified snapshot of the old schema exists before the migration writes |
| 3 | Rotation over simulated days and weeks | 24 hourly, 14 daily and 8 weekly, all inside the one backup directory |
| 4 | A snapshot that fails integrity_check | Deleted, reported, and never listed as a restore point |
| 5 | The pinned work volume absent, not mounted, or unwritable | Nothing is written anywhere (no SSD or iCloud fallback), the failure is recorded beside the store, `backup.list` and Settings show it, and the next bounded due check retries |
| 6 | The runbook on a fixture store | Restored store opens and holds the snapshot's records; the replaced files are kept |
| 7 | Snapshot duration on a live-size copied store | Read CPU time stays within the Spec 012 budget (a `timingTest`) |
| 8 | A snapshot whose compression fails, whose round trip does not verify, or that is killed mid-write | Nothing is published, the last verified snapshot is kept, the failure is reported, and no raw or temp file is left behind |
| 9 | A store that still says `auto_vacuum=0`, on an isolated fixture | One verified snapshot, one conversion, mode `2`, `integrity_check` ok, every row and setting identical, and a second start records the completion without a second rewrite |
| 10 | A conversion whose store is held, whose disk is short, whose estimate exceeds the bound, or whose snapshot fails | Recorded as refused or failed with its numbers, the original store openable and unchanged, and writers resume |
| 11 | A conversion interrupted before or after the rewrite | Unknown delivery is settled from the store's own mode: no duplicate rewrite, and a rewrite that landed is recorded as such (`landed`, not a verified conversion) |
| 13 | A competing writer or reader during the window, in this process or another | Refused before the rewrite, or blocked for the whole window; the attempt records which, and a store that cannot be exclusively taken is `refused` with its numbers |
| 14 | A same-length change to a stored value across the rewrite | Preservation verification fails, the record is `landed` with the difference, and no "unchanged" claim is made |
| 15 | FTS shadow tables rebuilt while their logical rows stay the same | The conversion verifies (the shadow representation is excluded, the virtual table's logical rows are hashed) and rowid identity still joins |
| 16 | A restart settling a rewrite that landed without verification | `landed` again, with the dead attempt's reason, snapshot and digest kept; no second `VACUUM`, no verified success from the mode |
| 17 | A roll replacing a service that is inside its maintenance window | The readiness wait counts the bounded window, exactly one replacement is spawned, and the marker is cleared when it is done |
| 12 | The hourly and daily prune passes | Freed pages are returned in bounded passes inside their page and time budget, the WAL is bounded, and an idle pass writes nothing |
| 18 | A migration with the backup volume away | The migration proceeds, no snapshot or fallback copy is written, and the outage is recorded durably |
| 19 | A snapshot on the new location | It is listed by `backup.list`, named by the board's snapshot health, and restores through the runbook |
