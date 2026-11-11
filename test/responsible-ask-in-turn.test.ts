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

test('worker and reviewer prompts carry the ask-in-turn rule on the one lifecycle (PR 850 collapsed the responsible branches)', () => {
  const worker = workerPrompt(promptTask(true), true);
  assert.ok(worker.includes(RESPONSIBLE_OWNERSHIP_RULE), 'responsible worker owns its decisions');
  assert.match(worker, /You own this task end to end/);
  assert.match(worker, /Record each material decision and why in the PR body as a short Decisions list so the reviewer can check it/);
  assert.match(worker, /When the brief is ambiguous, pick the reading that best serves its stated outcome, say so in the PR, and carry on/);
  assert.match(worker, /stop that specific risky action and choose a safe alternative within scope; it does not mean end your turn and ask/);
  assert.match(worker, /Ask through nucleus_ask only when a product or scope change or a release or outward action would change what the task delivers; budget extensions, including past 2x, are delegated under approve by default, Tom 2026-11-03/);
  assert.match(worker, /Do not seek approval for binary choices; approve by default, proceed and record the decision/);
  assert.match(worker, /A product or scope change is a discussion: raise it once with decision.add, including context, options and a recommendation/);
  assert.match(worker, /Do not report blocked for a decision you could make: report blocked only for something outside your control/);
  assert.ok(worker.includes(RESPONSIBLE_ASK_IN_TURN_RULE), 'responsible worker asks in-turn');
  assert.match(worker, /retained Nucleus reviewer is the independent review, including security review/);
  assert.match(worker, /In-session sub-agents are allowed/);
  assert.match(worker, /ask the retained reviewer only when you cannot settle the question yourself/);
  assert.match(worker, /A recommendation is a decision/);
  assert.match(worker, /a bounded diagnostic you recommend is yours to run/);
  assert.match(worker, /A 5xx or short forge failure is transient: wait and retry it yourself/);
  assert.match(worker, /back off from 5 seconds up to 60 seconds for about 15 minutes/);
  assert.match(worker, /Observe the remote branch or existing PR before every retry/);
  assert.doesNotMatch(worker, /Before you report blocked.*ask the retained reviewer/);
  assert.match(worker, /call the nucleus_ask MCP tool once inside the current turn/);
  assert.doesNotMatch(RESPONSIBLE_ASK_IN_TURN_RULE, /retained reviewer first|Decision: operator|planner or decider/);
  assert.match(worker, /Use kind: scope only when changing what the task delivers/);
  assert.match(worker, /Report blocked or error only if the task genuinely cannot proceed after the answer/);

  const revision = runPrompt(
    { ...promptTask(true), resolution: { revisionPrRepair: false, review: null } } as never,
    { id: 'run', role: 'revision', generation: 1, head } as Run,
    '/helper', '/ticket', true,
  );
  assert.ok(revision.includes(RESPONSIBLE_ASK_IN_TURN_RULE), 'responsible revision asks in-turn');
  assert.ok(revision.includes(RESPONSIBLE_OWNERSHIP_RULE), 'responsible revision owns its decisions');

  const reviewer = runPrompt(
    { ...promptTask(true), resolution: { review: null } } as never,
    { id: 'rev', role: 'reviewer', generation: 1, head } as Run,
    '/helper', '/ticket', true,
  );
  assert.ok(reviewer.includes(RESPONSIBLE_ASK_IN_TURN_RULE), 'responsible reviewer asks in-turn');
  assert.ok(reviewer.includes(RESPONSIBLE_OWNERSHIP_RULE), 'responsible reviewer owns its decisions');
  assert.match(reviewer, /You own this task end to end/);

  // Cutover 7 (PR 850): one lifecycle. A stored row without the responsible flag
  // runs the same prompts, so its worker and reviewer carry the rules too.
  const ordinaryWorker = workerPrompt(promptTask(false), true);
  assert.ok(ordinaryWorker.includes(RESPONSIBLE_ASK_IN_TURN_RULE), 'every worker asks in-turn');
  assert.match(ordinaryWorker, /You own this task end to end/, 'every worker owns its decisions');
  const ordinaryReviewer = runPrompt(
    { ...promptTask(false), resolution: { review: null } } as never,
    { id: 'rev', role: 'reviewer', generation: 1, head } as Run,
    '/helper', '/ticket', true,
  );
  assert.ok(ordinaryReviewer.includes(RESPONSIBLE_ASK_IN_TURN_RULE), 'every reviewer asks in-turn');
  assert.match(ordinaryReviewer, /You own this task end to end/, 'every reviewer owns its decisions');
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
        return answered;
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
        return [{ requestId: 'q3', question: 'Which API should it keep?', answers: { 'Which API should it keep?': 'Keep the touched API' } }];
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
        if (agentId !== 'worker') return [];
        // Race: the worker was replaced after enumeration; the answer belongs
        // to the obsolete agent and must not resume the new worker.
        store.update(taskId, { agentId: 'worker-2' }, 'worker_remapped');
        return [{ requestId: 'q4', question: 'Which API?', answers: { 'Which API?': 'Keep it' } }];
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
        if (agentId !== 'reviewer-1') return [];
        // Race: the reviewer was replaced after enumeration.
        const run = store.run('rev-1')!;
        store.putRun({ ...run, agentId: 'reviewer-2' });
        return [{ requestId: 'q5', question: 'Ship?', answers: { 'Ship?': 'Hold' } }];
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
      answeredQuestions: async () => [{ requestId: 'q2', question: 'Ship or hold?', answers: { 'Ship or hold?': 'Hold' } }],
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
