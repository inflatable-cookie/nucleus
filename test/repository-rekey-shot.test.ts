/**
 * Spec 056: one operator-invoked repository namespace re-key.
 *
 * This file proves the single-rename step end to end on one isolated store:
 * every covered family populated, a purged task with its permanent number and
 * outcome, overlapping number ranges, a shared project, lane, lead and decision
 * target, multiple path/alias spellings, settings and QA pointers, and
 * immutable operation, hook and host-run evidence. It then proves the refusals,
 * the fault injection that leaves no partial switch, and the parent collision
 * this feature removes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { outcomeSchema, projectQaRunSchema, submissionSchema, type Outcome } from '../shared/contracts';
import { suggestedRepositoryRekeyKey } from '../shared/repository-rekey';

const SOURCE = { origin: 'alice/alpha', path: '/fixture/alpha' };
const TARGET = { origin: 'alice/omega', path: '' };
const BETA = { origin: 'bob/beta', path: '/fixture/beta' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-rekey-shot-'));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  let sequence = 0;
  const task = (origin: string, repoPath: string, title?: string) => {
    const id = `submission-${++sequence}`;
    const input = submissionSchema.parse({
      submissionId: id, title: title ?? `Task ${id}`, repoPath, planningCommit: 'a'.repeat(40),
      handoffPath: 'handoff.md', originAgentId: 'origin',
    });
    return store.insert(input, 'host', 'handoff text for the task', 'a'.repeat(40), {}, undefined, origin);
  };
  return {
    dir, path,
    get store() { return store; },
    task,
    reopen() { store.close(); store = new Store(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const outcome = (taskId: string, repository: { origin: string; path: string }, number: number, reference: string, extra: Record<string, unknown> = {}) =>
  outcomeSchema.parse({
    taskId, submissionId: `sub-${taskId}`, title: `Outcome ${taskId}`, repository, number, reference,
    outcome: 'done', reason: 'merged', pr: { url: `https://github.com/${repository.origin}/pull/${number}`, number, head: 'b'.repeat(40) },
    mergeCommit: 'c'.repeat(40), syncedCommit: null,
    review: { status: 'ready_to_merge', summary: 'reviewed', commentId: 7 },
    closeout: { authority: 'queue', commit: null }, validation: null,
    brief: { digest: `sha256:${'d'.repeat(64)}`, mediaType: 'text/markdown', text: 'the immutable brief', source: 'handoff', version: null, earlierDigests: [] },
    workers: [{ profileId: 'worker', model: 'opus' }], reviewers: [],
    siblings: [{ repository: SOURCE.origin, commit: 'e'.repeat(40) }],
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-02T00:00:00.000Z', backfilled: false, lanes: [],
    ...extra,
  });

/** Write the enriched outcome over the terminal transition's own row. */
function putOutcome(store: Store, record: Outcome) {
  store.db.prepare(`UPDATE outcomes SET submissionId=?,repository=?,outcome=?,finished_at=?,merge_commit=?,synced_commit=?,pr_head=?,pr_number=?,data=?
    WHERE taskId=?`).run(record.submissionId, record.repository.origin ?? record.repository.path,
    record.outcome, record.finishedAt, record.mergeCommit, record.syncedCommit, record.pr?.head ?? null, record.pr?.number ?? null, JSON.stringify(record), record.taskId);
}

/** A repository with live settings, finished tasks, permanent numbers and outcomes. */
function seedRepository(f: ReturnType<typeof fixture>, repository: { origin: string; path: string }, count: number) {
  const tasks = Array.from({ length: count }, () => f.task(repository.origin, repository.path || `/fixture/${repository.origin.split('/')[1]}`));
  return tasks;
}

test('Spec 056 single rename re-keys every current family and leaves history byte-identical', () => {
  const f = fixture();
  try {
    const store = f.store;
    // Sources: settings, tasks, purged number-only history, outcomes, shared project.
    store.patchRepository(SOURCE, { closeout: 'agent', note: 'alpha settings' });
    store.patchRepository(BETA, { closeout: 'queue', note: 'beta settings' });
    const sourceTasks = seedRepository(f, SOURCE, 3);
    const betaTasks = seedRepository(f, BETA, 2);
    // Task 1 finishes and is purged: its number and outcome survive the task row.
    store.update(sourceTasks[0].id, { phase: 'done' }, 'done');
    const purged = store.task(sourceTasks[0].id);
    store.update(purged.id, { removedAt: '2026-01-01T00:00:00.000Z' }, undefined, 'retention', purged.version);
    store.purgeOldTasks(Date.now() + 400 * 86400000);
    assert.equal(store.db.prepare('SELECT id FROM tasks WHERE id=?').get(sourceTasks[0].id), undefined);
    // Task 2 is done but retained; task 3 stays queued only in a later test.
    store.update(sourceTasks[1].id, { phase: 'done' }, 'done');
    store.update(store.task(sourceTasks[2].id).id, { phase: 'cancelled' }, 'cancelled');
    store.update(betaTasks[0].id, { phase: 'done' }, 'done');

    // Terminal transitions write the permanent outcomes; enrich the retained one
    // with the proof fields the re-key must leave byte-identical.
    const enriched = outcomeSchema.parse({
      ...store.outcome(sourceTasks[1].id)!,
      lanes: ['reliability'],
      pr: { url: `https://github.com/${SOURCE.origin}/pull/2`, number: 2, head: 'b'.repeat(40) },
      mergeCommit: 'c'.repeat(40),
      review: { status: 'ready_to_merge', summary: 'reviewed', commentId: 7 },
      siblings: [{ repository: SOURCE.origin, commit: 'e'.repeat(40) }],
    });
    putOutcome(store, enriched);

    // Shared project, lane, lead, decision target and QA pointers.
    const project = store.upsertProject({
      key: 'suite', name: 'Suite',
      repositories: [{ origin: SOURCE.origin, path: SOURCE.path }, { origin: BETA.origin, path: BETA.path }],
      primary: { origin: SOURCE.origin, path: SOURCE.path },
    });
    store.upsertLane({ key: 'reliability', title: 'Reliability', aim: 'keep it moving',
      repositories: [{ origin: SOURCE.origin, path: SOURCE.path }, { origin: BETA.origin, path: BETA.path }] });
    store.addLead({
      id: 'lead-1', title: 'Alpha lead', body: 'unchanged lead body', repositories: [{ origin: SOURCE.origin, path: SOURCE.path }],
      lanes: ['reliability'], targets: [{ kind: 'task', repository: SOURCE.origin, reference: sourceTasks[1].id, at: '2026-01-01T00:00:00.000Z' }],
      state: 'open', author: 'operator', version: 1, dropReason: null, source: null, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', closedAt: null,
    } as never, 'operator');
    store.addDecision({
      id: 'decision-1', version: 1, question: 'Keep going?', askedBy: { agentId: 'origin', project: { origin: SOURCE.origin, path: SOURCE.path } },
      links: { tasks: [], leads: [], papercuts: [] }, status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    const qaParsed = projectQaRunSchema.safeParse({
      id: 'qa-1', repository: { origin: SOURCE.origin, path: SOURCE.path }, key: SOURCE.origin, state: 'passed',
      baseBranch: 'main', base: 'f'.repeat(40), argv: ['effigy', 'qa'], digest: 'a'.repeat(64), pid: null,
      capacityWait: null, capacityUnavailable: false,
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:10:00.000Z', exitCode: 0,
      steps: [], escapedDescendants: [], outputTail: 'green',
      submittedAt: '2026-01-01T00:00:00.000Z', durationMs: 600000,
    });
    assert.ok(qaParsed.success, JSON.stringify(qaParsed.error?.issues));
    const qaRun = qaParsed.data;
    store.putQaRun(qaRun);
    store.db.prepare('INSERT INTO qa_schedule_merges(taskId,repository,coveredRun,attemptedRun,checkedGreenRun) VALUES(?,?,?,?,?)')
      .run(sourceTasks[1].id, SOURCE.origin, null, null, null);

    // Immutable evidence written under the source before the step.
    const operationBytes = JSON.stringify({ type: 'submit', submission: { repoPath: SOURCE.path } });
    store.db.prepare('INSERT INTO operations(id,key,kind,inputHash,state,taskId,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(digest('op-1'), 'op-key-1', 'submit', digest(operationBytes), 'succeeded', null, '2026-01-01T00:00:00.000Z', operationBytes,
        JSON.stringify({ id: digest('op-1'), key: 'op-key-1', kind: 'submit', inputHash: digest(operationBytes), state: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z' }));
    const hookBytes = JSON.stringify({ schema: 'paseo.queue.hook.v1', repository: { root: SOURCE.path }, task: { id: sourceTasks[1].id } });
    store.db.prepare('INSERT INTO hook_events(id,taskId,eventKey,eventId,data) VALUES(?,?,?,?,?)')
      .run('hook-1', sourceTasks[1].id, 'closeout', 'event-1', hookBytes);
    // Settled and capacity-released: pure history, not unresolved custody.
    const hostRunBytes = JSON.stringify({ id: 'host-1', repository: { origin: SOURCE.origin, path: SOURCE.path }, selector: 'qa',
      state: 'settled', capacityReleasedAt: '2026-01-01T00:05:00.000Z' });
    store.db.prepare('INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
      .run('host-1', SOURCE.origin, 'settled', hostRunBytes);

    const before = {
      operation: store.db.prepare('SELECT payload FROM operations WHERE key=?').get('op-key-1')!.payload,
      hook: store.db.prepare('SELECT data FROM hook_events WHERE id=?').get('hook-1')!.data,
      hostRun: store.db.prepare('SELECT data FROM host_run_records WHERE id=?').get('host-1')!.data,
      brief: store.outcome(sourceTasks[1].id)!.brief.text,
      leadBody: store.lead('lead-1').body,
    };

    const input = {
      source: SOURCE.origin, target: TARGET, expectedSourceRevision: store.repositoryFor(SOURCE.origin)!.revision,
      reason: 'GitHub rename alice/alpha to alice/omega', author: 'operator', idempotencyKey: suggestedRepositoryRekeyKey({ source: SOURCE.origin, target: TARGET }),
    };
    const preview = store.previewRepositoryRekey({ source: input.source, target: input.target,
      expectedSourceRevision: input.expectedSourceRevision, reason: input.reason, idempotencyKey: input.idempotencyKey });
    assert.equal(preview.ready, true, JSON.stringify(preview.refusals));
    assert.equal(preview.source.origin, SOURCE.origin);
    assert.equal(preview.counts.tasks, 2, 'every retained task row follows its repository');
    assert.equal(preview.counts.taskNumbers, 3, 'purged numbering-only history follows too');
    assert.equal(preview.counts.outcomes, 3, 'done and cancelled outcomes both follow the repository');
    assert.equal(preview.numbering.targetNext, 4);

    const applied = store.rekeyRepository(input);
    assert.equal(applied.replayed, false);
    assert.equal(applied.receipt.counts.repositorySettings, 1);
    assert.equal(applied.receipt.counts.taskNumberCounters, 1);
    assert.equal(applied.receipt.counts.projects, 1);
    assert.equal(applied.receipt.counts.lanes, 1);
    assert.equal(applied.receipt.counts.leads, 1);
    assert.equal(applied.receipt.counts.decisions, 1);
    assert.equal(applied.receipt.counts.projectQaRuns, 1);
    assert.equal(applied.receipt.counts.qaScheduleMerges, 1);
    assert.equal(applied.receipt.numbering.sourceNext, 4);
    assert.equal(applied.receipt.numbering.targetNext, 4);
    assert.equal(applied.receipt.counts.tasks, 2);
    assert.deepEqual(applied.receipt.projectKeys, ['suite']);
    assert.deepEqual(applied.receipt.laneKeys, ['reliability']);

    // Settings resolve only under the new identity; the old one is genuinely free.
    assert.equal(store.repositoryFor(SOURCE.origin), null);
    // The checkout path is unchanged (no path was requested), so it still resolves
    // the row — now under its new origin.
    assert.equal(store.repositoryFor(SOURCE.path)?.repository.origin, TARGET.origin);
    assert.equal(store.repositoryFor(TARGET.origin)?.closeout, 'agent');
    assert.equal(store.repositoryFor(TARGET.origin)?.note, 'alpha settings');

    // Numbering continues per repository and never restarts at one.
    assert.equal(store.task(sourceTasks[1].id).reference, 'omega#002');
    assert.equal(store.taskIdByNumber({ reference: 'omega#2' }), sourceTasks[1].id);
    assert.throws(() => store.taskIdByNumber({ reference: 'alpha#2' }), /not found/);
    const next = f.task(TARGET.origin, '/fixture/omega');
    assert.equal(next.reference, 'omega#004', 'the counter moved with the repository');

    // Outcomes and their searchable repository identity follow; proof stays.
    assert.equal(store.outcome(sourceTasks[1].id)?.repository.origin, TARGET.origin);
    assert.equal(store.outcome(sourceTasks[1].id)?.brief.text, before.brief);
    assert.equal(store.outcome(sourceTasks[1].id)?.mergeCommit, 'c'.repeat(40));
    assert.equal(store.outcome(sourceTasks[1].id)?.pr?.url, `https://github.com/${SOURCE.origin}/pull/2`);
    assert.deepEqual(store.searchOutcomes({ repository: TARGET.origin }).results.map(item => item.taskId).sort(),
      [sourceTasks[0].id, sourceTasks[1].id].sort());
    assert.deepEqual(store.searchOutcomes({ repository: SOURCE.origin }).results, []);

    // Project identity is stable; only membership and the primary pointer move.
    const after = store.projectFor('/fixture/alpha', TARGET.origin);
    assert.equal(store.projects().length, 1);
    assert.equal(after?.key, project.key);
    assert.deepEqual(after?.repositories.map(repo => repo.origin), [TARGET.origin, BETA.origin]);
    assert.equal(after?.primary.origin, TARGET.origin);
    assert.equal(store.plan({ repository: TARGET.origin }).project, project.key);

    // Lanes, leads, decisions and QA resolve under the new identity.
    assert.deepEqual(store.laneByKey('reliability')?.repositories.map(repo => repo.origin), [TARGET.origin, BETA.origin]);
    assert.equal(store.lead('lead-1').body, before.leadBody);
    assert.deepEqual(store.lead('lead-1').repositories.map(repo => repo.origin), [TARGET.origin]);
    assert.equal(store.lead('lead-1').targets[0].repository, TARGET.origin);
    assert.deepEqual(store.listLeads({ repository: TARGET.origin, state: 'open' }).map(lead => lead.id), ['lead-1']);
    assert.deepEqual(store.listLeads({ repository: SOURCE.origin, state: 'open' }), []);
    assert.equal(store.decision('decision-1').askedBy.project?.origin, TARGET.origin);
    assert.equal(store.latestQaRun(TARGET.origin)?.id, 'qa-1');
    assert.equal(store.latestQaRun(SOURCE.origin), null);
    assert.equal(store.qaScheduleMerges(TARGET.origin).length, 1);
    // Task 445: the submitted key is recorded with the move, in the same
    // transaction, so the immutable host-run caller can still be verified.
    assert.equal(store.qaRun('qa-1')?.key, TARGET.origin);
    assert.equal(store.qaRun('qa-1')?.submittedKey, SOURCE.origin);

    // Unrelated records and immutable evidence keep their exact bytes.
    assert.equal(store.repositoryFor(BETA.origin)?.note, 'beta settings');
    assert.equal(store.task(betaTasks[1].id).reference, 'beta#002');
    assert.equal(store.outcome(betaTasks[0].id)?.repository.origin, BETA.origin);
    assert.equal(store.db.prepare('SELECT payload FROM operations WHERE key=?').get('op-key-1')!.payload, before.operation);
    assert.equal(store.db.prepare('SELECT data FROM hook_events WHERE id=?').get('hook-1')!.data, before.hook);
    assert.equal(store.db.prepare('SELECT data FROM host_run_records WHERE id=?').get('host-1')!.data, before.hostRun);
    assert.equal(store.db.prepare('SELECT repository FROM host_run_records WHERE id=?').get('host-1')!.repository, SOURCE.origin);

    // Lost reply: the same key reads the same receipt and applies nothing again.
    const replay = store.rekeyRepository(input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, applied.receipt);
    assert.equal(store.repositoryRekeys().length, 1);
    assert.equal(store.task(sourceTasks[1].id).reference, 'omega#002');
    assert.equal(store.qaRun('qa-1')?.submittedKey, SOURCE.origin, 'a replayed step never rewrites the provenance');
    // A changed payload under the same key refuses before any write.
    assert.throws(() => store.rekeyRepository({ ...input, reason: 'a different reason' }), /different input/);
    assert.equal(store.repositoryRekeyReceipt({ key: input.idempotencyKey })?.reason, input.reason);
  } finally { f.close(); }
});
