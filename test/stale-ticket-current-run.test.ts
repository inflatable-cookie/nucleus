/**
 * nucleus#1376: a retained thread's shell may still export the ticket of the run
 * that was current when it started. That ticket is a live credential for an
 * earlier run of the *same* probe thread, never a licence to guess: Nucleus
 * resolves it to the thread's current run, and refuses anything wider with the
 * run in force and the fix named. The shapes here are the ones seen live on
 * nucleus#1371 — the initial worker's ticket while its revision run is current.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import type { Run } from '../shared/contracts';
import { submissionSchema, taskControlInputSchema } from '../shared/contracts';
import { formatAgentId } from '../shared/agent-identity';
import { materializeRunContext } from '../core/dispatch/prompt-text/context-store';
import { askBinding } from '../core/questions/agent-ask';
import { startCallbacks } from '../service/callbacks/callback';
import { observeIdle } from './support/fakes';

const head = 'a'.repeat(40);

function runOf(
  id: string,
  taskId: string,
  overrides: Partial<Run> & { hostId?: string } = {},
): Run {
  return {
    id,
    taskId,
    role: 'revision',
    status: 'running',
    generation: 1,
    head,
    base: head,
    agentId: 'worker',
    hostId: 'host',
    workspaceId: 'ws',
    profile: null,
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Run;
}

const acceptedReport = (taskId: string, runId: string) => ({
  eventId: `settled-${runId}`,
  taskId,
  runId,
  status: 'blocked',
  headline: 'Stopped on the previous round',
  summary: 'Stopped on the previous round',
}) as unknown as Run['completion'];

async function fixture(options: { workerDirectoryContent?: string } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-stale-ticket-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  const engine = new Engine(store, {
    observe: observeIdle('ws', 'worker'),
  } as unknown as Adapter);
  const task = store.insert(
    submissionSchema.parse({
      submissionId: 'stale-ticket',
      title: 'Stale ticket',
      repoPath: '/fixture',
      planningCommit: head,
      originAgentId: 'origin',
    }),
    'host',
    'brief',
    head,
  );
  // The initial worker lives on the task row, never as a run row (nucleus#561).
  store.update(task.id, {
    phase: 'working',
    runId: 'run-worker',
    agentId: 'worker',
    workspaceId: 'ws',
    temporaryDirectory: dir,
  });
  store.setCredential('run-worker', 'worker-token');
  if (options.workerDirectoryContent)
    materializeRunContext(dir, 'run-worker', {
      rules: options.workerDirectoryContent,
      validation: options.workerDirectoryContent,
      proofs: options.workerDirectoryContent,
      history: options.workerDirectoryContent,
    });
  const socketPath = join(dir, 'socket');
  const stop = await startCallbacks(socketPath, join(dir, 'helper.mjs'), engine);
  const call = (
    path: string,
    token: string,
    body: Record<string, unknown>,
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request(
        {
          socketPath,
          path,
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  return {
    dir,
    store,
    engine,
    task,
    call,
    close: async () => {
      await engine.stop();
      await stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a retained worker ticket resolves to the revision run that is current on its thread', async () => {
  const f = await fixture({ workerDirectoryContent: 'worker' });
  try {
    // A revision run started on the retained worker's own thread. The shell still
    // exports the initial worker run's ticket: same agent, same proven host.
    f.store.putRun(runOf('run-revision', f.task.id));
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: 'run-revision',
      },
    });
    f.store.setCredential('run-revision', 'revision-token');
    const currentDirectory = join(f.dir, 'current');
    mkdirSync(currentDirectory, { mode: 0o700 });
    f.store.putRun(
      runOf('run-revision', f.task.id, { temporaryDirectory: currentDirectory }),
    );
    materializeRunContext(currentDirectory, 'run-revision', {
      rules: 'current-rules',
      validation: 'current-validation',
      proofs: 'current-proofs',
      history: 'current-history',
    });

    // nucleus helper report context history: the run-context read.
    const context = await f.call('/run-context', 'worker-token', {
      callerTaskId: f.task.id,
      callerRunId: 'run-worker',
      section: 'history',
    });
    assert.equal(context.status, 200, context.body);
    assert.equal(
      JSON.parse(context.body),
      'current-history',
      'the context read is the current run\'s own scratch, not the stale run\'s',
    );

    // The caller route every CLI verb resolves through, including nucleus ask.
    const caller = await f.call('/caller', 'worker-token', {
      taskId: f.task.id,
      runId: 'run-worker',
    });
    assert.equal(caller.status, 200, caller.body);
    assert.deepEqual(JSON.parse(caller.body), {
      caller: formatAgentId('host', 'worker'),
      hostId: 'host',
      source: 'run-ticket',
    });

    // ask and tell bind the run identity through the same rule.
    const bound = askBinding(
      f.store,
      f.store.task(f.task.id),
      'run-worker',
    );
    assert.equal(bound.id, 'run-revision');
    assert.equal(bound.role, 'revision');
    assert.equal(bound.agentId, 'worker');

    // The one resolution is visible on the task, so an operator can see the shell
    // is stale instead of inferring it from a refusal.
    assert.equal(
      f.store.events(f.task.id).filter((event) => event.kind === 'stale_ticket_resolved').length,
      1,
    );

    // The final report is the current run's result, and the retired run keeps its
    // own record untouched.
    const report = {
      eventId: 'e'.repeat(64),
      taskId: f.task.id,
      runId: 'run-worker',
      status: 'blocked',
      headline: 'Still blocked on the same premise',
      summary: 'Still blocked on the same premise',
      cause: { kind: 'external', name: 'premise' },
    };
    const completed = await f.call('/complete', 'worker-token', report);
    assert.equal(completed.status, 200, completed.body);
    assert.deepEqual(JSON.parse(completed.body), {
      accepted: true,
      eventId: report.eventId,
    });
    assert.equal(f.store.run('run-revision')?.completion?.runId, 'run-revision');
    assert.equal(f.store.run('run-revision')?.completion?.status, 'blocked');
    assert.equal(
      f.store.run('run-worker'),
      null,
      'the initial worker run is still a task-row identity, not a new run',
    );

    // An identical retry is the same accepted report, never a second settlement.
    const retried = await f.call('/complete', 'worker-token', report);
    assert.equal(retried.status, 200, retried.body);
    assert.deepEqual(JSON.parse(retried.body), {
      accepted: true,
      eventId: report.eventId,
    });
    assert.equal(
      f.store.events(f.task.id).filter((event) => event.kind === 'run_completion').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('the nucleus_report route settles a stale ticket\'s final report on the current run', async () => {
  // The /report route is what nucleus_report and the packaged helper use; its
  // own report intent and the completion receipt must name one run.
  const f = await fixture();
  try {
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.setCredential('run-old', 'old-token');
    f.store.putRun(runOf('run-new', f.task.id, { temporaryDirectory: f.dir }));
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: 'run-new',
      },
    });
    f.store.setCredential('run-new', 'new-token');

    const report = {
      eventId: 'b'.repeat(64),
      taskId: f.task.id,
      runId: 'run-old',
      status: 'blocked',
      headline: 'Still blocked at the reviewed head',
      summary: 'Still blocked at the reviewed head',
      cause: { kind: 'external', name: 'premise' },
    };
    const reported = await f.call('/report', 'old-token', report);
    assert.equal(reported.status, 200, reported.body);
    assert.deepEqual(JSON.parse(reported.body), {
      accepted: true,
      eventId: report.eventId,
    });
    assert.equal(f.store.run('run-new')?.completion?.runId, 'run-new');
    assert.equal(f.store.run('run-new')?.completion?.status, 'blocked');
    assert.equal(
      f.store.run('run-old')?.completion?.status,
      'blocked',
      'the previous run keeps its own recorded result',
    );

    // The identical retry collects the recorded response, never a second result
    // and never a receipt conflict between the two runs it names.
    const retried = await f.call('/report', 'old-token', report);
    assert.equal(retried.status, 200, retried.body);
    assert.deepEqual(JSON.parse(retried.body), {
      accepted: true,
      eventId: report.eventId,
    });
    assert.equal(
      f.store.events(f.task.id).filter((event) => event.kind === 'run_completion').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("another task's ticket cannot act on this task, even on the same thread", async () => {
  const f = await fixture();
  try {
    // Task A's released run: the stale ticket the retained thread still holds.
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.setCredential('run-old', 'old-token');
    // Task B runs on the same agent and host, so only the task ownership check
    // stops A's credential from acting for B.
    const other = f.store.insert(
      submissionSchema.parse({
        submissionId: 'stale-ticket-other',
        title: 'Other task',
        repoPath: '/fixture',
        planningCommit: head,
        originAgentId: 'origin',
      }),
      'host',
      'brief',
      head,
    );
    f.store.update(other.id, {
      phase: 'working',
      runId: 'run-worker',
      agentId: 'worker',
      workspaceId: 'ws',
      temporaryDirectory: f.dir,
    });
    f.store.putRun(runOf('run-other', other.id, { temporaryDirectory: f.dir }));
    f.store.update(other.id, {
      resolution: {
        ...f.store.task(other.id).resolution,
        currentRunId: 'run-other',
      },
    });
    f.store.setCredential('run-other', 'other-token');

    const context = await f.call('/run-context', 'old-token', {
      callerTaskId: other.id,
      callerRunId: 'run-old',
      section: 'rules',
    });
    assert.equal(context.status, 409);
    assert.match(
      JSON.parse(context.body).error,
      /task and run identity do not match|another task/,
    );

    const report = await f.call('/report', 'old-token', {
      eventId: 'c'.repeat(64),
      taskId: other.id,
      runId: 'run-old',
      status: 'blocked',
      headline: 'Task A result on task B',
      summary: 'Task A result on task B',
    });
    assert.equal(report.status, 409, report.body);
    assert.match(JSON.parse(report.body).error, /Stale reporting run|Stale run/);
    assert.equal(f.store.run('run-other')?.completion, null);

    // ask and tell read the same identity: B's turn cannot be asked with A's
    // ticket, so the binding refuses rather than recording the question on B.
    assert.throws(
      () => askBinding(f.store, f.store.task(other.id), 'run-old'),
      /Stale reporting run/,
    );

    // Self-force is the path that could move or retry an effect: A's credential
    // names A's task, so B is not its own task.
    await assert.rejects(
      f.engine.taskControlFromAgent(
        { taskId: other.id, runId: 'run-old', token: 'old-token' },
        taskControlInputSchema.parse({
          taskId: other.id,
          version: f.store.task(other.id).version,
          action: 'move',
          to: 'work',
          force: true,
          reason: 'idle with no tool child',
        }),
      ),
      /another task/,
    );
    assert.equal(
      f.store.operations({ taskId: other.id }).length,
      0,
      'no operation is recorded for the refused force',
    );
  } finally {
    await f.close();
  }
});

test('a released run ticket resolves while the same thread works a newer run', async () => {
  const f = await fixture();
  try {
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.setCredential('run-old', 'old-token');
    f.store.putRun(runOf('run-new', f.task.id, { temporaryDirectory: f.dir }));
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: 'run-new',
      },
    });
    f.store.setCredential('run-new', 'new-token');
    materializeRunContext(f.dir, 'run-new', {
      rules: 'new-rules',
      validation: 'new-validation',
      proofs: 'new-proofs',
      history: 'new-history',
    });

    const context = await f.call('/run-context', 'old-token', {
      callerTaskId: f.task.id,
      callerRunId: 'run-old',
      section: 'rules',
    });
    assert.equal(context.status, 200, context.body);
    assert.equal(JSON.parse(context.body), 'new-rules');
  } finally {
    await f.close();
  }
});

test('another thread\'s ticket is refused, names the run in force and records nothing', async () => {
  const f = await fixture();
  try {
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.setCredential('run-old', 'old-token');
    // The current run belongs to a *different* thread on the same task.
    f.store.putRun(
      runOf('run-new', f.task.id, { agentId: 'another-worker' }),
    );
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: 'run-new',
      },
    });
    f.store.setCredential('run-new', 'new-token');

    const refused = await f.call('/run-context', 'old-token', {
      callerTaskId: f.task.id,
      callerRunId: 'run-old',
      section: 'rules',
    });
    assert.equal(refused.status, 409);
    const message = JSON.parse(refused.body).error as string;
    assert.match(message, /Stale Nucleus assignment/);
    assert.match(message, /run-old/, 'the refusal names the ticket\'s run');
    assert.match(message, /run-new/, 'the refusal names the run in force');
    assert.match(
      message,
      /Use the ticket path named in the current run/,
      'the refusal names the fix',
    );

    const report = await f.call('/complete', 'old-token', {
      eventId: 'f'.repeat(64),
      taskId: f.task.id,
      runId: 'run-old',
      status: 'blocked',
      headline: 'Stale thread report',
      summary: 'Stale thread report',
    });
    assert.equal(report.status, 409, report.body);
    assert.equal(f.store.run('run-new')?.completion, null);
  } finally {
    await f.close();
  }
});

test('a thread with no current run is refused with the reason, not a stale assignment', async () => {
  const f = await fixture();
  try {
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.setCredential('run-old', 'old-token');

    const refused = await f.call('/run-context', 'old-token', {
      callerTaskId: f.task.id,
      callerRunId: 'run-old',
      section: 'rules',
    });
    assert.equal(refused.status, 409);
    const message = JSON.parse(refused.body).error as string;
    assert.match(message, /has no current run/);
    assert.match(message, /Resume or restart the task from Nucleus/);
  } finally {
    await f.close();
  }
});

test('a stale ticket never settles another role\'s run on the same thread', async () => {
  const f = await fixture();
  try {
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.setCredential('run-old', 'old-token');
    // Same agent, same host — but the thread's current run is a review, so the
    // worker's report cannot become the reviewer's verdict.
    f.store.putRun(runOf('run-review', f.task.id, { role: 'reviewer' }));
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: 'run-review',
      },
    });
    f.store.setCredential('run-review', 'review-token');

    const refused = await f.call('/run-context', 'old-token', {
      callerTaskId: f.task.id,
      callerRunId: 'run-old',
      section: 'rules',
    });
    assert.equal(refused.status, 409);
    assert.match(JSON.parse(refused.body).error, /run-review/);

    const report = await f.call('/complete', 'old-token', {
      eventId: 'a'.repeat(64),
      taskId: f.task.id,
      runId: 'run-old',
      status: 'blocked',
      headline: 'Worker result on a review turn',
      summary: 'Worker result on a review turn',
    });
    assert.equal(report.status, 409, report.body);
    assert.equal(f.store.run('run-review')?.completion, null);
  } finally {
    await f.close();
  }
});

test('a revoked credential is refused before any thread resolution', async () => {
  const f = await fixture();
  try {
    f.store.putRun(
      runOf('run-old', f.task.id, {
        released: true,
        status: 'finished',
        completion: acceptedReport(f.task.id, 'run-old'),
      }),
    );
    f.store.putRun(runOf('run-new', f.task.id));
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: 'run-new',
      },
    });
    f.store.setCredential('run-new', 'new-token');

    const refused = await f.call('/run-context', 'wrong-token', {
      callerTaskId: f.task.id,
      callerRunId: 'run-old',
      section: 'rules',
    });
    assert.equal(refused.status, 401, refused.body);
  } finally {
    await f.close();
  }
});
