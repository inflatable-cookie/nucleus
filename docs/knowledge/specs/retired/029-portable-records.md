# 029 — Portable records

Status: retired (Tom, 2026-10-31, R3 in [vision](../../vision.md#simplification-rulings-2026-10-31)). `records.export`, `records.import`, their CLI routes, the daily backup export and the contract-008 mapping are removed; export directories already written stay inert history. The design below is retained history.
Owner: Queue runtime maintainers
Created: 2026-09-27
Decision owner: Tom
Governing refs: the format is owned by Nucleus, `docs/knowledge/contracts/008-portable-records.md`
(nucleus main 361bea7, PR #41, which amended it after Queue's worker found gaps; amended again at
nucleus 88084db, PR #76, section "Real-data rules", after the first live seed import); [Spec 028](../028-store-backups.md) (backups),
[Spec 018](../018-queue-owned-closeout-and-durable-outcomes.md) (outcomes),
[Spec 026](../026-planning-records.md) and [Spec 027](../027-multi-repository-projects.md)
(planning records and projects); the seed's stream position is [Spec 034](034-shadow-run-stream.md)
(contract 009 "Shadow-run stream", snapshot boundary); Spec 043 stage history landed in Nucleus 008 at
`4a3ec1b4628a2a1e9cb390a72a9c860b93bc258f`, and the guard now pins 008 at
`14b9c2c457e828c5495bee92b81061c8bd182f98`.

## Problem

Queue's store is the only home of the permanent project records. Tom wants to move
to Nucleus without a schema-to-schema migration (2026-09-27). Nucleus contract 008
defines a host-neutral export, `nucleus.records` version 1, that Nucleus will
import. Queue exports it continuously and proves it's complete.

The contract owns the container, canonical JSON, actor shape, version rules,
referential integrity, strictness and the required fields per kind. This spec owns
only Queue's side. Any new field goes into contract 008 first.
As of nucleus cd60db2, papercuts are tagged leads (Spec 026 revision): `leads` carries
them, and `papercuts` is an optional legacy kind that is imported but not exported.

## Queue's side

- **Mapping.** Each Queue table holding permanent records maps to one contract
  kind, using the contract's camelCase kind and field names: `projects`,
  `projectTombstones` (from `project_tombstones`), `repositorySettings`,
  `taskNumberCounters`, `lanes`, `laneDocuments`,
  `projectPlans`, `leads` (with `lead_versions` and papercut-tagged leads), `briefDrafts`,
  `outcomes` (with task numbers and the outcome lane index),
  `submissionTombstones` (from `tombstones`) and `decisions`. Operational tables
  stay out, as the contract says. References that can't resolve in Queue's real data (tombstones
  purged before outcomes existed, drafts promoted to still-live tasks) are written
  with the contract's `unresolved` marker.
- **Contract first.** A new portable kind or field lands in Nucleus contract 008
  before Queue exports it; Queue's PR cites the 008 SHA. Nucleus's importer
  refuses unknown kinds, so an export ahead of the contract fails a whole seed.
  `projectTombstones` shipped ahead of 008 (#112); nucleus#068 back-filled it at
  nucleus `5d53b93` (Nucleus Chatterbox, 2026-09-30).
  Outcome `routing.profileRequests` (Spec 036's worker, reviewer and
  coordinator requests) also shipped ahead of 008, with #124. Nucleus defined
  it at `4aa79cb` after the stream-0005 seed failed to import (2026-10-01).
  The field-level QA guard (`Spec 029 QA guard` in `test/portable-records.test.ts`)
  exports a fixture with every kind and optional field populated and refuses any
  exported path outside `host` that `test/fixtures/contract-008-fields.json` does
  not pin to the 008 SHA it names (`14b9c2c` today); host holds identities only,
  so any other `host` field fails the same way. Enum-valued pins also check their
  values (`values` in the same file). Spec 041's plan `horizon: next` and
  `doneWhen` shipped ahead of 008 too; Nucleus added them at `72465d6`
  (2026-10-04). Spec 042's project owner is host-local and is not exported.
  A validation result's `terminationSignal` is the runtime teardown signal, not a
  portable result; Nucleus excluded it from contract 008 at `14b9c2c`
  (2026-10-06), so the export strips it and the guard fixture does not pin it.
- **Declared stage history** (Spec 043, contract 008 at Nucleus `4a3ec1b`). An
  outcome carries `stageRuns` only when the task had declared stages. Queue maps
  settled records to the portable results `advanced`, `invalidated` or `failed`;
  running rows remain operational. Stage definitions stay in `brief.text`, not
  in a second parsed `stages` field. The field and its result enum are in the QA
  guard fixture.
- **Decisions.** Contract 008's optional additive `decisions` kind carries each
  Spec 032 record, its version history and durable notice delivery summary.
  Decision links remain their exact Queue string arrays and import does not create
  linked tasks, leads or papercuts. Missing targets read as terminal for stale
  decisions; the derived `stale` value is not exported. Version-1 exports written
  before this kind existed still import.
- **Project tombstones.** Spec 027's `project.remove` writes `{key, repositories,
  reason, removedAt}`. The export omits a project named by a tombstone and carries
  the tombstone; the import never restores a tombstoned project. The kind is
  optional, so an export written before it existed still imports; contract 008
  defines the kind at nucleus `5d53b93`. Task numbers, outcomes and closed
  leads for the removed project's repositories travel as usual.
- **Real-data mappings** (contract 008 real-data rules, nucleus 88084db). The first live
  seed exposed shapes the contract had not named: a brief draft's lead is written in `source`
  (`{kind: "lead", id}`) and `leadId` is never exported; a lead target's `repository` is a
  `Repo`, or null for `question` and `knowledge` targets; a lead's task target whose reference
  matches no exported outcome is written `{taskId, unresolved}`; an outcome sibling's
  `repository` is an embedded `Repo`; and a validation result's `digest` is `sha256:<hex>`.
  `records.import` accepts both these shapes and the previous strings, `leadId` and bare
  validation digest, so an older export still imports and re-exports in the current shape.
- **Actors.** Queue's free-string authors, approvers and filers map to the
  contract's actor: "operator" and "operator (board)" become `operator`, "import"
  becomes `system`, a UUID becomes an `agent` with the UUID under `host.agentId`,
  and any other string becomes an `agent` with that name. Relayed approval and its
  note stay top-level; Paseo workspace and profile IDs go under `host`.
- **Lead release binding (Queue #294, 2026-10-08).** Queue's internal lead record
  binds approval to `baseBranch` and `planningCommit`, but the pinned Nucleus
  contract 008 does not include `leads.baseBranch`, `versions[].check.baseBranch`,
  `approval.baseBranch` or `approval.planningCommit`. Export omits those fields
  until Nucleus updates 008. An imported lead therefore has the contract's
  default `main` base and must be checked and approved for its target head before
  promotion; a portable round-trip does not preserve a release-line approval.
- **Reopen audit (Queue #334, 2026-10-14).** A reopened lead's drop–reopen
  history (`leads.reopens`, Spec 026) is Queue-local planning audit; the pinned
  contract 008 field set does not include it. Export omits `reopens` and carries
  the resulting state truthfully: an imported reopened lead reads `open` with no
  `dropReason`, `closedAt` or reopen episodes, like a lane whose drain episodes
  do not travel.
- **Commands.** `records.export` writes a contract directory from one consistent
  snapshot. `records.import` loads one into an empty store, refusing a non-empty
  store, a dangling reference, or an unknown kind or field outside `host`. Both
  are RPC and CLI methods, documented in the README and the Queue skill.
- **Stream boundary.** A seed export taken while the shadow stream (Spec 034) is running
  also writes `shadow-boundary.json` next to `manifest.json`: `{stream, seq, at}`, the
  stream file, the last journaled `seq` and the snapshot time. It is read in the same read
  transaction as the records, so an event racing the export lands either inside the snapshot
  or after the boundary, never both. The effective setting resolves exactly as the
  producer's own `config()` does: the host `settings.json` setting (Spec 034) first, then the
  live `shadowStream` override. Because the export's child process cannot read settings.json,
  a producer records the host setting it was built with in the meta table, so a
  settings-enabled stream keeps its journal boundary even when a stale live override says
  disabled, and a settings-disabled stream with earlier history still writes
  `{stream: null, seq: 0, at}`. A stream the effective setting disables, or one that has
  written no journal rows, writes `{stream: null, seq: 0, at}`. The boundary is evidence
  for the Nucleus feeder, not records: the 008 manifest schema is unchanged and
  `records.import` ignores the sidecar. An export without the sidecar (written before it
  existed) still reads, with a null boundary.
- **Seed per segment** (contract 009 as amended at Nucleus
  `533cb4b67a79c984ae8cb9c490b286910a184c99`). Spec 034 captures the export
  records and old-segment boundary in the rotation's SQLite transaction. It
  assigns an outcome's lines as one group before inserting its portable row in
  that transaction. If the group triggers rotation, the seed
  ends at the old segment's last line and excludes the outcome whose lines
  start the new segment. Each rotation writes a `nucleus.records` v1 seed
  directory with `manifest.json` and `shadow-boundary.json`; Queue retains the
  latest 14 directories, using mode 0700 for directories and 0600 for files.
  The manifest SHA-256 and boundary are reported by `shadow.status`. This
  does not add a portable kind or field.
- **Backups.** The daily backup (Spec 028) also writes an export next to its
  snapshot, `<stem>.daily.records/`, in the same backup directory and with the
  same rotation. The export reads the verified snapshot, so it holds exactly its
  records. A failed export stays visible as the backup's local error, and every
  later run that day retries it from the same daily snapshot until a verified
  export exists. An export directory that fails verification is removed and
  replaced.
- **Empty store.** Import needs every table except `meta` (operator
  configuration) and SQLite's own bookkeeping to be empty, operational tables
  included. It needs every kind in the manifest except optional `briefDrafts`,
  `papercuts`, `projectTombstones` and `decisions`.
- **Where Queue data lands** (contract 008 at 361bea7). Paseo agent IDs go in an
  actor's `host.agentId`, a draft's or lead's origin agent in `host.originAgentId`,
  and worker and reviewer profile IDs in the outcome's `host.workerProfileIds` and
  `host.reviewerProfileIds`. Host holds identities only: a validation result's
  `queueBuild`, `settingsRevision`, `pid`, `terminationSignal`, host-scheduler
  telemetry, live capacity wait and `capacityUnavailable` are operational, not
  durable outcome facts, and are no longer exported (Nucleus rulings, 2026-10-01
  and 2026-10-06); their home is
  contract 010's scheduler journal and the shadow events, and import still takes
  historical admission telemetry from an older export. A lane's
  `closedAutomatically` is true exactly when it is `done` with the idle-close note.
  Projects export their current `visibility`; import restores it.
- **Task references.** A reference to a task without an outcome is written
  `unresolved`: `live` when the task is still in the store, else
  `purged-before-outcomes`. Queue's import is a cutover, so it refuses `live`.
- **Task numbers.** An outcome's number belongs to the counter its `reference`
  names: the outcome's own repository, or the one counter with that name when
  the outcome was recorded before its origin was known.
- **Not carried.** A tombstone's submission input digest (contract 008 has no
  field; nothing reads it) and task numbers of tasks with neither an outcome nor
  a live row. Import writes an empty input digest. Decision staleness is derived
  from current linked-record state.
- **QA guard.** Every table holding permanent records has an export mapping or an
  explicit "operational" entry. A new table without either fails QA, naming it.
  Milestone QA runs (`project_qa_runs`, task 104) stay out as operational run
  history — argv, base, exit code, duration, output tail, pid and Effigy
  admission telemetry per run, same class as role runs and hook events — until
  contract 008 gains a kind for them. The whole history already travels in the
  SQLite backups.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Export a live-size copied store | Every contract kind present; manifest counts and sha256 match; every record carries its required fields |
| 2 | Export, import into an empty store, export again | Byte-identical exports (canonical JSON) |
| 3 | Records with Paseo identities and relayed approvals | Agent, workspace and profile IDs only under `host`; relayed approval and its note top-level |
| 4 | A dangling reference, an unknown kind, an unknown field outside `host`, a non-empty target store | Import refused; nothing written |
| 5 | A new permanent table with no mapping | QA fails, naming the table |
| 6 | Daily backup | A verified export beside the snapshot in the one backup directory |
| 7 | A seed export with the shadow stream enabled, empty or racing a write | `shadow-boundary.json` holds the last journaled `seq` at the snapshot, or `{stream: null, seq: 0}` when the effective host/live setting is disabled or nothing has been written; the host setting wins over a stale live override, and the record read shares the boundary's transaction |
| 8 | A removed project (Spec 027) | The export omits the project, carries its `projectTombstones` entry, and import restores neither the project nor a plan for it; an export written before the kind existed still imports |
| 9 | Spec 032 decisions | Export includes all four statuses, exact links and delivery summary; import preserves links without creating targets; missing targets read terminal; an export without the optional kind still imports |
