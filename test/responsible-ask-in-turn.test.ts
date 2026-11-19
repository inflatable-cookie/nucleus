import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Resolution } from '../core/resolution';
import { workerPrompt, runPrompt, RESPONSIBLE_ASK_IN_TURN_RULE, RESPONSIBLE_OWNERSHIP_RULE } from '../core/dispatch/prompts';
import { submissionSchema, type Profile, type Run } from '../shared/contracts';

const head = 'a'.repeat(40);
const profile = (id: string, model: string): Profile => ({ id, name: id, model, provider: 'fixture', available: true, problem: '', notes: '', supportedThinking: [] });

function promptTask(responsible?: boolean) {
  return {
    id: 'task', runId: 'initial', title: 'Build', originAgentId: 'origin', coordinatorAgentId: null,
    dependsOn: [], branch: 'ns-task', baseBranch: 'main', repoPath: '/repo', workspaceId: 'workspace',
    directory: '/worktree', handoffPath: 'handoff.md', planningCommit: head, retiredWorkers: [],
    skipPRReview: false, prUrl: 'https://github.com/example/repo/pull/1', prHead: head,
    reason: 'Review', completion: { status: 'ready_for_review', prNumber: 1 },
    resolution: { revisionPrRepair: false, review: null },
    ...(responsible === undefined ? {} : { responsible }),
  } as unknown as Parameters<typeof workerPrompt>[0];
}

test('each role points to its own standing guidance', () => {
  const worker = workerPrompt(promptTask(true), true);
  const revision = runPrompt(promptTask(true), { id: 'run', role: 'revision', generation: 1, head } as Run, '/helper', '/ticket', true);
  const reviewer = runPrompt(promptTask(true), { id: 'rev', role: 'reviewer', generation: 1, head } as Run, '/helper', '/ticket', true);
  assert.match(worker, /Worker rules/); assert.match(revision, /Worker rules/);
  assert.match(reviewer, /Reviewer rules/);
  assert.doesNotMatch(reviewer, /how to fix what the reviewer found/);
  for (const prompt of [worker, revision, reviewer]) assert.match(prompt, /Never resend an unknown delivery/);
});

function blockedWorkerStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-ask-in-turn-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const author = profile('author', 'author');
  const task = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Blocked worker', repoPath: join(dir, 'repo'),
    planningCommit: head, brief: { text: 'Blocked worker brief\n' },
    originAgentId: 'origin', responsible: true,
  }), 'host', 'brief', head);
  store.update(task.id, {
    phase: 'blocked', workspaceId: 'workspace', directory: join(dir, 'worktree'),
    agentId: 'worker', runId: 'initial', profile: author,
    prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
    reason: 'Worker blocked: which API should it keep?',
    completion: { taskId: task.id, runId: 'initial', eventId: 'completion-1', status: 'blocked', summary: 'Which API should it keep?', prNumber: 1, head },
  }, 'worker_blocked');
  return { dir, store, taskId: task.id, author };
}

test('a blocked responsible task whose worker question is answered resumes that worker with the answers, once', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    const answered = [{ requestId: 'q1', question: 'Which API should it keep?', answers: { 'Which API should it keep?': 'Keep the public API' } }];
    const adapter = {
      answeredQuestions: async (agentId: string) => {
        assert.equal(agentId, 'worker');
        return { ok: true as const, answered };
      },
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    const applied: unknown[] = [];
    resolution.applyOperatorControl = (async (input: unknown) => {
      applied.push(input);
      // Mimic the ordinary move to=work: clear the stop and park a revision run.
      const current = store.task(taskId);
      store.update(current.id, { phase: 'changes_requested', reason: 'Resumed with answers' }, 'resumed');
      store.putRun({
        id: 'revision-1', taskId, role: 'revision', generation: 1, head,
        agentId: 'worker', workspaceId: 'workspace', profile: author,
        status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
        active: true, idleSince: null, completion: null, released: false,
        instruction: (input as { instruction?: string }).instruction ?? null,
      } as unknown as Run);
      return store.task(taskId);
    }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(applied.length, 1, 'the answered question continues the worker once');
    const input = applied[0] as { action: string; to: string; instruction: string; reason: string; note: string };
    assert.equal(input.action, 'move');
    assert.equal(input.to, 'work');
    assert.match(input.instruction, /Keep the public API/);
    assert.match(input.instruction, /Continue the work in the same run with these answers/);
    assert.match(input.reason, /q1/);
    const events = store.eventsAll(taskId);
    assert.equal(events.filter(event => event.kind === 'worker_question_answered').length, 1);
    assert.equal(events.filter(event => event.kind === 'worker_question_resumed').length, 1);

    // Once: the recorded answer is the fence, so a second sweep sends nothing more.
    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(applied.length, 1, 'an answered question is never resent');
    assert.equal(store.eventsAll(taskId).filter(event => event.kind === 'worker_question_answered').length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version change between enumeration and control still resumes with a durable outcome', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    let touchedVersion = -1;
    const adapter = {
      answeredQuestions: async () => {
        // Race: the task version moves after enumeration but before the
        // answers are observed. The resume must build from the fresh version
        // and still record a durable outcome, never silently consume.
        store.update(taskId, { reason: 'Worker blocked: which API should it keep? (touched)' }, 'touched');
        touchedVersion = store.task(taskId).version;
        return { ok: true as const, answered: [{ requestId: 'q3', question: 'Which API should it keep?', answers: { 'Which API should it keep?': 'Keep the touched API' } }] };
      },
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    const applied: unknown[] = [];
    resolution.applyOperatorControl = (async (input: unknown) => {
      applied.push(input);
      const current = store.task(taskId);
      store.update(current.id, { phase: 'changes_requested', reason: 'Resumed with answers' }, 'resumed');
      store.putRun({
        id: 'revision-1', taskId, role: 'revision', generation: 1, head,
        agentId: 'worker', workspaceId: 'workspace', profile: author,
        status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
        active: true, idleSince: null, completion: null, released: false,
        instruction: (input as { instruction?: string }).instruction ?? null,
      } as unknown as Run);
      return store.task(taskId);
    }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(applied.length, 1, 'the still-blocked task continues despite the version race');
    assert.equal((applied[0] as { version: number }).version, touchedVersion, 'the control is built from the fresh version');
    assert.match((applied[0] as { instruction: string }).instruction, /Keep the touched API/);
    const events = store.eventsAll(taskId);
    assert.equal(events.filter(event => event.kind === 'worker_question_answered').length, 1);
    assert.equal(events.filter(event => event.kind === 'worker_question_resumed').length, 1, 'a resumed outcome is recorded');
    assert.equal(events.filter(event => event.kind === 'worker_question_unknown').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an answer from a replaced worker is never applied to the new worker', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    const adapter = {
      answeredQuestions: async (agentId: string) => {
        if (agentId !== 'worker') return { ok: true as const, answered: [] };
        // Race: the worker was replaced after enumeration; the answer belongs
        // to the obsolete agent and must not resume the new worker.
        store.update(taskId, { agentId: 'worker-2' }, 'worker_remapped');
        return { ok: true as const, answered: [{ requestId: 'q4', question: 'Which API?', answers: { 'Which API?': 'Keep it' } }] };
      },
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    const applied: unknown[] = [];
    resolution.applyOperatorControl = (async (input: unknown) => {
      applied.push(input);
      return store.task(taskId);
    }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(applied.length, 0, 'an obsolete agent answers for no one');
    const events = store.eventsAll(taskId);
    assert.equal(events.filter(event => event.kind === 'worker_question_answered').length, 1);
    assert.equal(events.filter(event => event.kind === 'worker_question_unknown').length, 1);
    assert.match(events.find(event => event.kind === 'worker_question_unknown')!.detail, /worker agent changed/);
    assert.equal(events.filter(event => event.kind === 'worker_question_resumed').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an answer from a replaced reviewer is never applied to the new reviewer', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    store.putRun({
      id: 'rev-1', taskId, role: 'reviewer', generation: 1, head,
      agentId: 'reviewer-1', workspaceId: 'workspace', profile: author,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(),
      active: false, idleSince: new Date().toISOString(),
      completion: { taskId, runId: 'rev-1', eventId: 'rev-blocked', status: 'blocked', summary: 'Needs a call', head },
      released: true,
    } as unknown as Run);
    const adapter = {
      answeredQuestions: async (agentId: string) => {
        if (agentId !== 'reviewer-1') return { ok: true as const, answered: [] };
        // Race: the reviewer was replaced after enumeration.
        const run = store.run('rev-1')!;
        store.putRun({ ...run, agentId: 'reviewer-2' });
        return { ok: true as const, answered: [{ requestId: 'q5', question: 'Ship?', answers: { 'Ship?': 'Hold' } }] };
      },
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    const applied: unknown[] = [];
    resolution.applyOperatorControl = (async (input: unknown) => {
      applied.push(input);
      return store.task(taskId);
    }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(applied.length, 0, 'an obsolete reviewer answers for no one');
    const events = store.eventsAll(taskId);
    assert.equal(events.filter(event => event.kind === 'reviewer_question_answered').length, 1);
    assert.equal(events.filter(event => event.kind === 'reviewer_question_unknown').length, 1);
    assert.match(events.find(event => event.kind === 'reviewer_question_unknown')!.detail, /reviewer agent changed/);
    assert.equal(events.filter(event => event.kind === 'reviewer_question_resumed').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lost resumption is recorded as unknown and never resent', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    const adapter = {
      answeredQuestions: async () => ({ ok: true as const, answered: [{ requestId: 'q2', question: 'Ship or hold?', answers: { 'Ship or hold?': 'Hold' } }] }),
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    let calls = 0;
    resolution.applyOperatorControl = (async () => {
      calls++;
      throw Error('move to=work refused: task moved on');
    }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(calls, 1);
    const events = store.eventsAll(taskId);
    assert.equal(events.filter(event => event.kind === 'worker_question_answered').length, 1);
    assert.equal(events.filter(event => event.kind === 'worker_question_unknown').length, 1);

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(calls, 1, 'an unknown observation is never resent');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable answered-question read is recorded as unknown once and never resumes the task', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    const adapter = {
      // The host cannot read the transcript: unknown, not "nothing was answered".
      answeredQuestions: async () => ({ ok: false as const, reason: 'the agent timeline page could not be read' }),
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    let calls = 0;
    resolution.applyOperatorControl = (async () => { calls++; }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(calls, 0, 'an unreadable read never resumes the worker');
    const unknown = store.eventsAll(taskId).filter(event => event.kind === 'worker_question_read_unknown');
    assert.equal(unknown.length, 1, 'the lost read is recorded once');
    assert.match(unknown[0]!.detail, /timeline page could not be read/);

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(store.eventsAll(taskId).filter(event => event.kind === 'worker_question_read_unknown').length, 1,
      'the same lost read is not recorded again');
    assert.equal(calls, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing answered-question read is the same unknown as a refusal', async () => {
  const { dir, store, taskId, author } = blockedWorkerStore();
  try {
    const adapter = {
      answeredQuestions: async () => { throw Error('T3Code timeout: orchestration.subscribeThread'); },
    } as unknown as ConstructorParameters<typeof Resolution>[1];
    const resolution = new Resolution(store, adapter, () => [author], () => false);
    let calls = 0;
    resolution.applyOperatorControl = (async () => { calls++; }) as typeof resolution.applyOperatorControl;

    await resolution.resumeResponsibleAnsweredQuestions();
    assert.equal(calls, 0);
    const unknown = store.eventsAll(taskId).filter(event => event.kind === 'worker_question_read_unknown');
    assert.equal(unknown.length, 1);
    assert.match(unknown[0]!.detail, /T3Code timeout/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
