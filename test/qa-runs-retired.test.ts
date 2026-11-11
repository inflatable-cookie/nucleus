/**
 * Spec 035 "Retired runs on the board". A run whose capacity accounting is
 * retired (the operator's exact-run disposition or the automatic retirement on
 * the producer's cleanup) stays `running` in the pinned contract 010 record for
 * good, so the QA runs tab's Now list read every one of them as live work and
 * grew without bound (Tom, 2026-10-25: "failed runs are backing up"). The board
 * now joins the private bulk accounting read: a retirement bound to the run's
 * exact id and epoch moves the run to history with an honest label, and every
 * other case keeps it on Now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mount, useNativeStubs } from './support/render';
import { hostRunRecordSchema, type HostRunAccountingList, type HostRunRecord, type Project } from '../shared/contracts';

useNativeStubs();
const load = () => import('../client/qa-runs-tab');
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const repository = { origin: 'owner/project-e', path: '/project-e' };
const projects = [{ key: 'project-e', name: 'project-e', repositories: [repository], primary: repository, visibility: 'active',
  owner: { agentId: 'thread', assignedBy: 'operator', assignedAt: '2026-10-25T00:00:00.000Z', note: '' } }] as unknown as Project[];

const at = new Date(Date.now() - 60_000).toISOString();
const run = (id: string, state: 'queued' | 'running' | 'settled', epoch = 1): HostRunRecord => hostRunRecordSchema.parse({
  id, epoch, caller: 'queue:effigy-admission', repository, selector: `qa:stage:${id}`, runClass: 'heavy', classSource: 'manifest',
  priority: 'interactive', state, submittedAt: at, capacityDeadlineAt: at, runTimeoutMs: 60_000,
  budgetFallback: { cpu: 1, memoryBytes: 100 }, budget: { cpu: 1, memoryBytes: 100, wallMs: null, source: 'fallback' },
  position: state === 'queued' ? 1 : null, admittedAt: state === 'queued' ? null : at, launchedAt: state === 'queued' ? null : at,
  settledAt: state === 'settled' ? at : null, capacitySample: null, pid: null, processGroupId: null, startIdentity: null,
  settlement: null, wallMs: null, cpuMs: null, containers: [],
  capacityReleasedAt: state === 'settled' ? at : null, capacityReleaseReason: state === 'settled' ? 'settled' : null,
  capacityReleaseKind: state === 'settled' ? 'automatic' : null,
});
const runs = [run('charged', 'running'), run('waiting', 'queued'), run('done', 'settled'), run('by-operator', 'running'),
  run('by-producer', 'running'), run('by-absence', 'running'), run('unreadable', 'running'), run('epoch-moved', 'running', 2)];
const entry = (runId: string, extra: Partial<HostRunAccountingList['entries'][number]> = {}) => ({
  runId, epoch: 1, accounting: 'retired' as const, format: 'queue.host-run.accounting-disposition', disposedAt: at, producer: null, ...extra });
const list: HostRunAccountingList = { readAt: at, complete: true, entries: [
  entry('by-operator'),
  entry('by-producer', { format: 'queue.host-run.accounting-retirement', producer: { verdict: 'failed', state: 'failed', exitCode: 7, signal: null } }),
  entry('by-absence', { format: 'queue.host-run.accounting-absence-retirement' }),
  entry('unreadable', { accounting: 'unreadable', format: null, disposedAt: null }),
  // Read against epoch 1; the row has since moved to epoch 2, so it is not covered.
  entry('epoch-moved'),
] };

async function render(accountingList: HostRunAccountingList | undefined, error: unknown = null) {
  const { QaRunsTab, runAccounting } = await load();
  const accounting = runAccounting(runs, accountingList, error);
  const ui = mount(h(QaRunsTab, { runs, qaRuns: [], accounting, projects, tasks: [], selectedProjects: [], busy: false,
    onRunQa() {}, onCancelQa() {}, onRetryTeardownQa() {}, onReleaseCapacity() {}, onOpenTask() {}, c }));
  const section = (label: string) => {
    const node = ui.get(label);
    const ids: string[] = [];
    const visit = (item: { props: Record<string, any>; children: unknown[] } | string) => {
      if (typeof item === 'string') return;
      const match = /^QA run row (.+)$/.exec(item.props.accessibilityLabel ?? '');
      if (match) ids.push(match[1]);
      for (const child of item.children) visit(child as never);
    };
    visit(node as never);
    return ids.sort();
  };
  return { ui, accounting, now: section('Now'), results: section('Results') };
}

test('a retirement bound to the run id and epoch moves the run from Now to history with an honest label', async () => {
  const { ui, now, results } = await render(list);
  assert.deepEqual(now, ['charged', 'epoch-moved', 'unreadable', 'waiting'], 'charged, waiting and uncovered runs stay live');
  assert.deepEqual(results, ['by-absence', 'by-operator', 'by-producer', 'done'], 'retired runs join settled history');
  assert.equal(ui.all('Outcome Retired · outcome unknown · custody unknown').length, 2,
    'the operator and foreground-absence retirements claim no outcome or custody');
  assert.ok(ui.get('Outcome Retired · outcome unknown · custody unknown · producer reported failed'), "the producer's verdict is attributed, not pinned");
  assert.ok(ui.get('Outcome Running · retirement unreadable'), 'an unreadable record stays visible and charged');
  assert.match(ui.text(), /Accounting retired .* · on the producer's cleanup/);
  assert.match(ui.text(), /Accounting retired .* · by the operator/);
  assert.match(ui.text(), /Accounting retired .* · its hook died and Effigy holds no record of it/);
});

test('without the accounting read every unsettled run stays on Now, and a failed read says so', async () => {
  // The parent shape: the pinned list alone, which grew without bound.
  const missing = await render(undefined);
  assert.deepEqual(missing.now, ['by-absence', 'by-operator', 'by-producer', 'charged', 'epoch-moved', 'unreadable', 'waiting']);
  const failed = await render(undefined, new Error('service unavailable'));
  assert.deepEqual(failed.now, missing.now, 'a failed read hides nothing');
  assert.match(failed.ui.text(), /Retired-run status could not be read \(service unavailable\)/);
  const partial = await render({ ...list, complete: false });
  assert.deepEqual(partial.now, ['charged', 'epoch-moved', 'unreadable', 'waiting'], 'a partial read still retires only what it names');
  assert.match(partial.ui.text(), /some may still show here/);
});

test('the board counts only live runs on the QA runs tab button', async () => {
  const { liveHostRun, runAccounting } = await load();
  const accounting = runAccounting(runs, list, null);
  assert.deepEqual(runs.filter(item => liveHostRun(item, accounting)).map(item => item.id).sort(), ['charged', 'epoch-moved', 'unreadable', 'waiting']);
  assert.deepEqual(runs.filter(item => liveHostRun(item)).map(item => item.id).sort(),
    ['by-absence', 'by-operator', 'by-producer', 'charged', 'epoch-moved', 'unreadable', 'waiting'], 'no accounting read: nothing is hidden');
});
