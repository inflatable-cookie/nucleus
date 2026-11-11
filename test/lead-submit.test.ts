import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { RuntimePlanning } from '../core/runtime/planning';
import { git } from '../core/git/index';
import { leadSubmit } from '../shared/contracts';
import { briefDigest } from '../core/planning/brief';
import type { Adapter } from '../core/host';

const title = 'Submit the fixture';
const body = `---\ntitle: ${title}\nqueue:\n  complexity: medium\n---\n\n## Outcome\nBuild the fixture.\n`;
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'submit-'));
  const repo = join(root, 'repo');
  await git(root, 'init', '--bare', '--initial-branch=main', join(root, 'origin.git'));
  await git(root, 'clone', join(root, 'origin.git'), repo);
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  await mkdir(join(repo, '.paseo'));
  await writeFile(join(repo, '.paseo/queue.json'), JSON.stringify({ schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [] }));
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fixture'); await git(repo, 'push', 'origin', 'main');
  const adapter = { client: { isConnected: true }, hostId: 'fixture-host', socketPath: join(root, 'callback.sock'), helperPath: join(root, 'helper.mjs'),
    connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }),
    originAgent: async (id: string) => ({ id, workspaceId: 'origin-ws', archived: false }) } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: join(root, 'data'), adapterFactory: () => adapter, timers: false });
  t.after(() => runtime.drain());
  await runtime.started; await runtime.bootstrap;
  runtime.store.setMeta('paused', true);
  const input = leadSubmit.input.parse({ repository: { origin: repo, path: repo }, title, body, agent: 'planner', note: 'Tom authorized this fixture' });
  return { runtime, input, repo };
}

test('one submission checks, records exact approval and returns the promoted task; repeating returns it', async t => {
  const { runtime, input } = await fixture(t);
  const result = leadSubmit.output.parse(await runtime.submitLead(input));
  assert.ok('taskId' in result);
  const task = runtime.store.task(result.taskId);
  assert.equal(task.title, title);
  assert.equal(result.reference, task.reference);
  const lead = runtime.listLeads({ state: 'promoted' })[0];
  assert.equal(lead.approval?.note, input.note);
  assert.equal(lead.approval?.approver, input.agent);
  assert.equal(lead.approval?.relayed, true);
  assert.equal(lead.approval?.digest, briefDigest(body));
  assert.equal(lead.approval?.planningCommit, task.planningCommit);
  assert.deepEqual(await runtime.submitLead(input), result);
  assert.equal(runtime.store.tasks().length, 1);
  // Completed and removed tasks still fence same-title submissions through permanent numbering.
  runtime.store.update(task.id, { phase: 'done', removedAt: new Date().toISOString(), reason: 'Fixture complete' });
  assert.deepEqual(await runtime.submitLead(input), result);
});

test('failed brief checks return their findings and never approve or promote', async t => {
  const { runtime, input } = await fixture(t);
  const result = await runtime.submitLead({ ...input, body: body.replace('complexity: medium', 'complexity: invalid') });
  assert.ok('lead' in result);
  assert.equal(result.lead.check?.ok, false);
  assert.match(result.lead.check?.message ?? '', /complexity/);
  assert.equal(result.lead.approval, null);
  assert.equal(runtime.store.tasks().length, 0);
});

test('an existing same-title lead is returned unchanged; concurrent submissions create only one', async t => {
  const { runtime, input } = await fixture(t);
  const lead = await runtime.addLead({ repositories: [input.repository], title, body: 'An earlier observation', lanes: [], author: 'earlier' });
  const result = await runtime.submitLead(input);
  assert.deepEqual(result, { lead });
  assert.equal(runtime.store.tasks().length, 0);
  const request = { ...input, title: 'Another fixture', body: body.replace(title, 'Another fixture') };
  const results = await Promise.all([runtime.submitLead(request), runtime.submitLead(request)]);
  assert.equal([...runtime.listLeads({ state: 'open' }), ...runtime.listLeads({ state: 'promoted' })].filter(item => item.title === request.title).length, 1);
  assert.equal(results.filter(item => 'taskId' in item).length, 1);
});

test('submission waits past compatibility responses for both check and promotion', async t => {
  const { runtime, input } = await fixture(t);
  const planning = (runtime as any).planning as RuntimePlanning;
  const original = runtime.engine.awaitOperation.bind(runtime.engine);
  const waits: number[] = [];
  runtime.engine.awaitOperation = async (id, timeout) => {
    waits.push(timeout!);
    // A compatibility response may still say pending even if the executor is fast.
    if (timeout !== Infinity) return runtime.store.operation(id)!;
    return original(id, 8_000);
  };
  const result = await planning.submitLead(input);
  assert.ok('taskId' in result);
  assert.equal(waits.filter(wait => wait === Infinity).length, 2);
});

test('submission refuses missing authorization and board impersonation before creating a lead', () => {
  const input = { repository: 'owner/repo', title, body, agent: 'planner', note: 'Authorized' };
  assert.equal(leadSubmit.input.safeParse(input).success, true);
  assert.equal(leadSubmit.input.safeParse({ ...input, note: ' ' }).success, false);
  assert.equal(leadSubmit.input.safeParse({ ...input, agent: 'operator (board)' }).success, false);
});
