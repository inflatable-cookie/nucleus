import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../core/store/store';
import { Leads } from '../core/planning/leads';
import { reapHookCheckouts } from '../core/hooks/hook-cleanup';
import { hookRecordSchema } from '../shared/hooks';
import { leadSchema, leadVersionSchema, noticeSchema, outcomeSchema, submissionSchema } from '../shared/contracts';
import { queueOperationSchema, type QueueOperation } from '../shared/operations';

/**
 * Audit B5/B7/B8/B10 storage and read benchmark (2026-10-25 performance audit,
 * main at d5e20937), on an isolated audit-shaped store.
 *
 * The audit measured the live database: 5,894 leads (272 open) with one 541-version
 * ledger at 137 MB, 2,400-plus notices, 11k operations, 6,792 outcomes, 10,679 hook
 * occurrences (10,460 of them orphaned), and a 17,637-row host-run journal. Those populations are reproduced here,
 * with a smaller ledger body so the fixture stays a test, and each parent read is
 * implemented beside the new one so the comparison never depends on another commit or
 * another machine's load. Every printed number is a median of the stated population and
 * cache state on this machine, not a guarantee for a loaded host or the live database.
 */

const LEADS = 5_894;
const OPEN_LEADS = 272;
const VERSIONS = 541;
const NOTICES = 2_400;
const OPERATIONS = 11_000;
const OUTCOMES = 6_792;
const HOOKS = 10_679;
const ORPHANS = 10_460;
const JOURNAL_ROWS = 17_637;
const SUPERSEDED = 300;
const HEAD = 'a'.repeat(40);
const STAMP = '2026-10-08T00:00:00.000Z';

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const timed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
const round = (value: number) => Number(value.toFixed(2));

/** Bytes that crossed the SQLite boundary for one read, by counting every row it returned. */
function readBytes(store: Store, fn: () => void): number {
  const db = store.db as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare.bind(store.db);
  let bytes = 0;
  db.prepare = (sql: string) => {
    const statement = original(sql) as { all: (...args: never[]) => unknown[]; get: (...args: never[]) => unknown };
    const wrap = (read: (...args: never[]) => unknown) => (...args: never[]) => {
      const result = read.call(statement, ...args);
      if (Array.isArray(result)) for (const row of result) bytes += Buffer.byteLength(JSON.stringify(row));
      else if (result) bytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    };
    statement.all = wrap(statement.all) as never;
    statement.get = wrap(statement.get) as never;
    return statement;
  };
  try { fn(); } finally { db.prepare = original; }
  return bytes;
}

function auditShapedStore() {
  const store = new Store(':memory:');
  const repository = { origin: 'audit/repository', path: '/audit' };
  const leadTemplate = leadSchema.parse({ id: 'template', title: 'Template', body: 'Body', repositories: [repository], lanes: ['lane-0'],
    author: 'owner', state: 'open', version: 1, dropReason: null, targets: [], source: null, createdAt: STAMP, updatedAt: STAMP, closedAt: null });
  const versionOf = (leadId: string, version: number, body: string) => leadVersionSchema.parse({ version, title: `${leadId} ${version}`,
    body, author: 'owner', createdAt: STAMP, digest: `sha256:${'d'.repeat(64)}`, check: null, approval: null });
  store.transaction(() => {
    const insertLead = store.db.prepare('INSERT INTO leads(id,state,content_key,data) VALUES(?,?,?,?)');
    const insertVersion = store.db.prepare('INSERT INTO lead_versions(leadId,version,data) VALUES(?,?,?)');
    for (let index = 0; index < LEADS; index++) {
      const lead = { ...leadTemplate, id: `lead-${index}`, title: `Lead ${index}`, body: `Body ${index} ${'b'.repeat(200)}`,
        state: index < OPEN_LEADS ? 'open' as const : 'promoted' as const, lanes: [`lane-${index % 240}`] };
      insertLead.run(lead.id, lead.state, null, JSON.stringify(lead));
      insertVersion.run(lead.id, 1, JSON.stringify(versionOf(lead.id, 1, lead.body)));
    }
    // The audit's ledger: 541 versions whose body grows to half a megabyte.
    for (let version = 1; version <= VERSIONS; version++) {
      const body = `Ledger entry ${version}\n${'L'.repeat(2_000 + version * 100)}`;
      insertVersion.run('ledger', version, JSON.stringify(versionOf('ledger', version, body)));
    }
    insertLead.run('ledger', 'open', null, JSON.stringify({ ...leadTemplate, id: 'ledger', title: 'Ledger',
      body: `Ledger entry ${VERSIONS}\n${'L'.repeat(2_000 + VERSIONS * 100)}`, version: VERSIONS, lanes: ['lane-0'] }));
  });

  const notices = noticeSchema.parse({ id: 'n', taskId: 'task', agentId: 'agent', recipientAgentId: 'agent', workspaceId: 'ws',
    sources: ['origin'], originEntry: false, kind: 'completion', status: 'delivered', error: '', text: 'notice' });
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO notices(id,taskId,data) VALUES(?,?,?)');
    for (let index = 0; index < NOTICES; index++)
      insert.run(`notice-${index}`, index % 5 === 0 ? `project:${index}` : `task-${index % 19}`,
        JSON.stringify({ ...notices, id: `notice-${index}`, status: index % 400 === 0 ? 'pending' : 'delivered', text: `Notice ${index} ${'x'.repeat(120)}` }));
  });

  const operationShape = queueOperationSchema.parse({ id: 'f'.repeat(64), key: 'k', kind: 'submit', inputHash: 'e'.repeat(64),
    state: 'succeeded', taskId: null, expectedVersion: null, repoPath: '/audit', submissionId: 'submission', createdAt: STAMP,
    startedAt: null, settledAt: null, attempts: 1, diagnostic: '', result: null, effect: null });
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO operations(id,key,kind,inputHash,state,taskId,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?,?)');
    for (let index = 0; index < OPERATIONS; index++) {
      const id = index.toString(16).padStart(64, '0');
      const operation: QueueOperation = { ...operationShape, id, key: `key-${index}`, state: index % 900 === 0 ? 'pending' : 'succeeded',
        submissionId: `submission-${index}`, createdAt: new Date(Date.parse(STAMP) + index * 1_000).toISOString() };
      insert.run(operation.id, operation.key, operation.kind, operation.inputHash, operation.state, null, operation.createdAt, 'null', JSON.stringify(operation));
    }
  });

  const outcomeShape = outcomeSchema.parse({ taskId: 'template', submissionId: 'template', title: 'Template', repository,
    outcome: 'done', reason: 'Completed', pr: null, mergeCommit: null, syncedCommit: null, review: null, validation: null,
    closeout: { authority: 'queue', commit: null }, brief: { digest: `sha256:${'b'.repeat(64)}`, mediaType: 'text/markdown', text: '' },
    workers: [], reviewers: [], siblings: [], startedAt: STAMP, finishedAt: STAMP, backfilled: false, lanes: [] });
  store.transaction(() => {
    const insertOutcome = store.db.prepare('INSERT INTO outcomes(taskId,submissionId,data) VALUES(?,?,?)');
    const insertFts = store.db.prepare('INSERT INTO outcomes_fts(rowid,title,brief,review,reason,taskId) VALUES(?,?,?,?,?,?)');
    for (let index = 0; index < OUTCOMES; index++) {
      const taskId = `history-${index}`;
      const record = { ...outcomeShape, taskId, submissionId: taskId, title: `History ${index}`,
        brief: { ...outcomeShape.brief, text: `brief ${index} ${'q'.repeat(64)}` }, finishedAt: new Date(Date.parse(STAMP) + index * 60_000).toISOString(),
        lanes: [`lane-${index % 240}`] };
      const result = insertOutcome.run(taskId, taskId, JSON.stringify(record));
      insertFts.run(Number(result.lastInsertRowid), record.title, record.brief.text, '', record.reason, taskId);
    }
    // The permanent rows are inserted directly here; the search projection's filter
    // columns are what `insertOutcomeRow` would have written.
    store.db.exec("UPDATE outcomes SET outcome='done', finished_at=json_extract(data,'$.finishedAt'), repository=json_extract(data,'$.repository.origin')");
  });

  const task = store.insert(submissionSchema.parse({ submissionId: 'live', title: 'Live', repoPath: '/audit', planningCommit: HEAD,
    handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', HEAD);
  const recordShape = hookRecordSchema.parse({ id: 'hook', taskId: task.id, hookId: 'closeout', event: 'task.closeout', eventId: 'e'.repeat(48),
    occurrence: 1, mode: 'integration_write', delivery: 'required', state: 'published',
    manifest: { path: '.paseo/queue.json', commit: HEAD, digest: `sha256:${'a'.repeat(64)}` },
    program: { kind: 'repository', executable: { path: '.paseo/hooks/closeout', commit: HEAD, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
    instruction: null, baseBranch: 'main', baseCommit: HEAD, attempt: 1, timeoutMs: 10_000, maxOutputBytes: 65_536, allowedPaths: [],
    commitSubject: null, eventDigest: 'b'.repeat(64), eventPayload: null, workspace: null, processId: null, result: null, commit: null,
    remote: null, summary: '', error: '', createdAt: STAMP, updatedAt: STAMP, reconciledAt: null });
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO hook_events(id,taskId,eventKey,eventId,data) VALUES(?,?,?,?,?)');
    for (let index = 0; index < HOOKS; index++) {
      const data = JSON.stringify({ ...recordShape, id: `hook-${index}`, taskId: index < ORPHANS ? `purged-${index}` : task.id,
        workspace: index < ORPHANS ? { path: `/audit/purged/${index}`, head: HEAD } : null });
      insert.run(`hook-${index}`, index < ORPHANS ? `purged-${index}` : task.id, `closeout:task.closeout`, `${index}`.padStart(48, '0'), data);
    }
    // The retired-occurrence shape the reaper's supersession check walks: 300 failed
    // 'Superseded before publication' occurrence of one logical event.
    for (let index = 0; index < SUPERSEDED; index++) {
      const eventId = `b${(SUPERSEDED - index).toString(16).padStart(47, '0')}`;
      const data = JSON.stringify({ ...recordShape, id: `superseded-${index}`, taskId: task.id, state: 'failed', occurrence: index + 1,
        eventId, summary: 'Superseded before publication', workspace: null });
      insert.run(`superseded-${index}`, task.id, `closeout:task.closeout`, eventId, data);
    }
  });

  store.transaction(() => {
    const insertJournal = store.db.prepare('INSERT INTO host_run_journal(run_id,event,at,data) VALUES(?,?,?,?)');
    for (let index = 0; index < JOURNAL_ROWS; index++) insertJournal.run(`run-${index % 300}`, 'settlement', STAMP, '{}');
  });
  return { store, task };
}

test('audit-shaped storage: lead reads, drains, notices, operations, search, replay, hook reap and retained producer bytes', async t => {
  const { store } = auditShapedStore();
  try {
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM leads').get()!.n, LEADS + 1);
    assert.equal(store.lanes().length, 0);

    // --- B7 lead reads: the ledger's detail, the check that writes one version, promotion metadata.
    const leads = new Leads(store);
    const ledger = store.lead('ledger');
    const parentDetail = () => store.leadVersions('ledger')
      .map(version => version.version === ledger.version ? { ...version } : (({ body: _body, ...meta }) => meta)(version));
    const parentBytes = readBytes(store, parentDetail);
    const summaryCold = timed(() => leads.getSummary({ id: 'ledger' }));
    const summaryBytes = readBytes(store, () => leads.getSummary({ id: 'ledger' }));
    const parentTiming: number[] = [], newTiming: number[] = [];
    for (let run = 0; run < 7; run++) { parentTiming.push(timed(parentDetail)); newTiming.push(timed(() => leads.getSummary({ id: 'ledger' }))); }
    assert.deepEqual(leads.getSummary({ id: 'ledger' }).versions.map(version => version.version), parentDetail().map(version => version.version),
      'the narrowed read lists exactly the same retained versions');
    assert.equal('body' in (leads.getSummary({ id: 'ledger' }).versions[0] as { body?: string }), false);

    const parentDigests = () => store.leadVersions('ledger').slice(0, -1).flatMap(version => version.digest ? [version.digest] : []);
    const parentDigestTiming: number[] = [], newDigestTiming: number[] = [];
    for (let run = 0; run < 7; run++) {
      parentDigestTiming.push(timed(parentDigests));
      newDigestTiming.push(timed(() => store.leadVersionDigestsBeforeLatest('ledger')));
    }
    assert.deepEqual(store.leadVersionDigestsBeforeLatest('ledger'), parentDigests());

    // The check path reads one exact version instead of the whole history.
    const parentCheck = () => store.leadVersions('ledger').at(-1)!;
    const parentCheckTiming: number[] = [], newCheckTiming: number[] = [];
    for (let run = 0; run < 7; run++) {
      parentCheckTiming.push(timed(parentCheck));
      newCheckTiming.push(timed(() => store.leadVersion('ledger', VERSIONS)));
    }
    assert.deepEqual(store.leadVersion('ledger', VERSIONS), parentCheck());

    // --- B7 open-lead drain read.
    const parentOpen = () => store.leads().filter(lead => lead.state === 'open');
    const parentOpenTiming: number[] = [], newOpenTiming: number[] = [];
    for (let run = 0; run < 7; run++) {
      parentOpenTiming.push(timed(parentOpen));
      newOpenTiming.push(timed(() => store.openLeads()));
    }
    assert.equal(store.openLeads().length, OPEN_LEADS + 1, 'the audit population plus the ledger');
    assert.deepEqual(store.openLeads().map(lead => lead.id), parentOpen().map(lead => lead.id));

    // --- B10 notices and the operations absence proof.
    const noticesParent: number[] = [], noticesIndexed: number[] = [];
    for (let run = 0; run < 9; run++) {
      noticesParent.push(timed(() => store.db.prepare("SELECT COUNT(*) AS count FROM notices WHERE json_extract(data, '$.status') IN ('pending','intent','uncertain')").get()));
      noticesIndexed.push(timed(() => store.unsettledNoticeCount()));
    }
    assert.equal(store.unsettledNoticeCount(), noticesParent.length ? Number((store.db.prepare("SELECT COUNT(*) AS count FROM notices WHERE json_extract(data, '$.status') IN ('pending','intent','uncertain')").get() as { count: number }).count) : -1);
    const noticePlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM notices WHERE json_extract(data,'$.status') IN ('pending','intent','uncertain')").all()
      .map(row => String((row as { detail: string }).detail)).join(' | ');
    assert.match(noticePlan, /notices_status/);

    const absenceQuery = "SELECT data FROM operations WHERE state != 'failed' AND (json_extract(data,'$.submissionId')=? OR state IN ('pending','running','needs_attention')) ORDER BY rowid";
    const absencePlanOf = () => store.db.prepare(`EXPLAIN QUERY PLAN ${absenceQuery}`).all('submission-7')
      .map(row => String((row as { detail: string }).detail)).join(' | ');
    const indexedPlan = absencePlanOf();
    assert.match(indexedPlan, /operations_submission/);
    assert.match(indexedPlan, /operations_state/);
    const absenceParent: number[] = [], absenceIndexed: number[] = [];
    for (let run = 0; run < 7; run++) {
      absenceIndexed.push(timed(() => store.operationsForAbsenceProof('submission-7')));
    }
    // Falsification: without the expression index the same query scans every retained operation.
    store.db.exec('DROP INDEX operations_submission');
    try {
      const scanPlan = absencePlanOf();
      assert.match(scanPlan, /SCAN operations/);
      for (let run = 0; run < 7; run++) absenceParent.push(timed(() => store.db.prepare(absenceQuery).all('submission-7')));
    } finally {
      store.db.exec("CREATE INDEX IF NOT EXISTS operations_submission ON operations(json_extract(data,'$.submissionId'))");
    }
    assert.equal(store.operationsForAbsenceProof('submission-7').length, 14);

    // --- B10 outcome search: the rewrite deletes one index row instead of scanning the FTS table.
    const parentReplace = () => store.transaction(() => {
      store.db.prepare('DELETE FROM outcomes_fts WHERE taskId=?').run('history-5');
      store.db.prepare("INSERT INTO outcomes_fts(title,brief,review,reason,taskId) VALUES(?,?,?,?,?)").run('History 5', 'brief', '', 'Completed', 'history-5');
      throw new Error('rollback');
    });
    const rowidReplace = () => store.transaction(() => {
      const rid = (store.db.prepare('SELECT rowid AS rid FROM outcomes WHERE taskId=?').get('history-5') as { rid: number }).rid;
      store.db.prepare('DELETE FROM outcomes_fts WHERE rowid=?').run(rid);
      store.db.prepare('INSERT INTO outcomes_fts(rowid,title,brief,review,reason,taskId) VALUES(?,?,?,?,?,?)').run(rid, 'History 5', 'brief', '', 'Completed', 'history-5');
      throw new Error('rollback');
    });
    const ftsParent: number[] = [], ftsRowid: number[] = [];
    for (let run = 0; run < 7; run++) {
      ftsParent.push(timed(() => { try { parentReplace(); } catch { /* rolled back on purpose */ } }));
      ftsRowid.push(timed(() => { try { rowidReplace(); } catch { /* rolled back on purpose */ } }));
    }
    assert.equal(store.searchOutcomes({ text: 'brief' } as never).results.length > 0, true);

    // --- B5/A10 hook reap over the audit's occurrence table.
    const records = store.hookEvents();
    assert.equal(records.length, HOOKS + SUPERSEDED);
    // The parent shape: `store.task()` per record (which threw for every purged task) and a
    // `records.some(...)` scan per superseded occurrence. Both are reproduced here over the
    // same array; the comparison count is the quadratic work the audit measured.
    let comparisons = 0;
    const parentWalk = () => {
      for (const record of records) {
        let task = null;
        try { task = store.task(record.taskId); } catch { task = null; }
        const terminal = task && (task.phase === 'done' || task.phase === 'cancelled' && task.disposition?.status === 'complete');
        if (terminal || record.state === 'published') continue;
        if (record.state === 'failed' && record.summary.startsWith('Superseded before publication'))
          comparisons += records.filter(next => next.taskId === record.taskId && next.hookId === record.hookId && next.event === record.event
            && next.occurrence > record.occurrence && next.eventId !== record.eventId).length;
      }
    };
    const parentWalkTiming: number[] = [];
    for (let run = 0; run < 3; run++) parentWalkTiming.push(timed(parentWalk));
    const readTiming: number[] = [];
    for (let run = 0; run < 3; run++) readTiming.push(timed(() => store.hookEventsPage(0, HOOKS + SUPERSEDED)));
    const reapStart = performance.now();
    const health = await reapHookCheckouts(store);
    const reapMs = performance.now() - reapStart;
    // With the orphans gone, a second pass measures the walk itself (519 occurrences).
    const repeatStart = performance.now();
    await reapHookCheckouts(store);
    const repeatMs = performance.now() - repeatStart;
    assert.equal(health.errorCount, 0, 'a purged task is skipped without an error per occurrence');
    assert.equal(health.reconciledCount, ORPHANS, 'every recorded-checkout-free orphan is reconciled once');

    const report = {
      audit: 'performance-audit 2026-10-25 B5/B7/B8/B10/A10; baseline main d5e20937',
      environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length,
        totalMemGiB: Number((totalmem() / 1024 ** 3).toFixed(1)), loadavg: loadavg().map(value => Number(value.toFixed(2))) },
      population: { leads: LEADS + 1, openLeads: OPEN_LEADS, ledgerVersions: VERSIONS, notices: NOTICES, operations: OPERATIONS,
        outcomes: OUTCOMES, hookOccurrences: HOOKS, orphanOccurrences: ORPHANS, journalRows: JOURNAL_ROWS },
      ms: {
        leadSummaryCold: round(summaryCold), leadSummaryParentMedian: round(median(parentTiming)), leadSummaryMetadataMedian: round(median(newTiming)),
        leadSummaryParentBytes: parentBytes, leadSummaryMetadataBytes: summaryBytes,
        leadDigestsParentMedian: round(median(parentDigestTiming)), leadDigestsMetadataMedian: round(median(newDigestTiming)),
        leadCheckParentMedian: round(median(parentCheckTiming)), leadCheckExactMedian: round(median(newCheckTiming)),
        openLeadsParentMedian: round(median(parentOpenTiming)), openLeadsIndexedMedian: round(median(newOpenTiming)),
        noticesScanMedian: round(median(noticesParent)), noticesIndexedMedian: round(median(noticesIndexed)),
        absenceScanMedian: round(median(absenceParent)), absenceIndexedMedian: round(median(absenceIndexed)),
        ftsScanDeleteMedian: round(median(ftsParent)), ftsRowidDeleteMedian: round(median(ftsRowid)),
        hookParentWalkMedian: round(median(parentWalkTiming)), hookReadMedian: round(median(readTiming)),
        hookReapFirstPass: round(reapMs), hookReapRepeatPass: round(repeatMs), hookReconcileBatches: Math.ceil(ORPHANS / 500),
        hookSupersessionComparisons: comparisons,
      },
      plans: { notices: noticePlan, absenceProofIndexed: indexedPlan, absenceProofWithoutIndex: 'SCAN operations' },
      parity: { ledgerVersionsListed: parentDetail().length, ledgerDigests: parentDigests().length, openLeads: store.openLeads().length,
        operationsInAbsenceProof: store.operationsForAbsenceProof('submission-7').length,
        hookErrorsCarried: health.errors.length, hookErrorCount: health.errorCount, orphansReconciled: health.reconciledCount },
    };
    t.diagnostic(JSON.stringify(report));
  } finally { store.close(); }
});
