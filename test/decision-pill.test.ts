import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import type { BoardHost, BoardPill } from '../client/shell/types';
import { mount, useNativeStubs } from './support/render';
import type { DecisionView } from '../shared/contracts';

useNativeStubs();

type DecisionPillModule = typeof import('../client/decision-pill');
let pillModule: DecisionPillModule;
let settled: Promise<DecisionPillModule> | null = null;
const ready = () => { settled ??= import('../client/decision-pill').then(module => (pillModule = module)); return settled; };

const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const tick = () => new Promise(resolve => setImmediate(resolve));

const project = { origin: 'owner/decisions', path: '/fixture/decisions' };
const decision = (over: Partial<DecisionView> = {}): DecisionView => ({
  id: over.id ?? 'decision-1', version: 1, question: over.question ?? 'Which branch do we cut?',
  headline: over.headline ?? over.question ?? 'Which branch do we cut?',
  choices: Object.hasOwn(over, 'choices') ? over.choices : [{ label: 'main', consequence: 'Use the stable branch.' }, { label: 'branch', consequence: 'Start from the feature branch.' }],
  recommended: over.recommended ?? 'main', details: over.details ?? null, overtakenBy: over.overtakenBy ?? [],
  context: over.context ?? null, options: over.options ?? ['main', 'branch'], recommendation: over.recommendation ?? 'main',
  askedBy: over.askedBy ?? { agentId: 'agent-asker', project }, links: over.links ?? { tasks: [], leads: [], papercuts: [] },
  askerLabel: over.askerLabel ?? 'agent-asker',
  status: 'open', answer: null, withdrawal: null, supersededBy: null, delivery: null,
  createdAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T10:00:00Z', versions: [], stale: false, projectKey: 'projectKey' in over ? over.projectKey ?? null : 'decisions',
});

type PillContribution = { id: string; workspaceId: string; agentId: string; button: BoardPill };
type RecordedPill = PillContribution & { updates: Partial<BoardPill>[]; removed: boolean; remove(): void; update(patch: Partial<BoardPill>): void };

/** A plugin client stub: agents feed, plugin RPC, pill registration. */
function fakeClient(options: { agents?: { id: string; workspaceId?: string; cwd?: string }[]; open?: DecisionView[]; answerError?: Error;
  projects?: Record<string, { key: string; name: string } | null> } = {}) {
  const recorded: { pills: RecordedPill[]; lists: number; resolves: string[][]; answers: Record<string, unknown>[]; withdrawals: Record<string, unknown>[]; panels: { id: string; options: unknown }[] } = {
    pills: [], lists: 0, resolves: [], answers: [], withdrawals: [], panels: [],
  };
  let listeners: ((update: { kind: string; agent?: { id: string; workspaceId?: string }; agentId?: string }) => void)[] = [];
  let open = options.open ?? [];
  const client = {
    rpc: async (contract: { name: string }, input: Record<string, unknown>) => {
      if (contract.name === 'queue.ui-snapshot') return {};
      if (contract.name === 'decision.list') {
        recorded.lists++;
        const asker = input.asker as string | undefined;
        return asker ? open.filter(entry => entry.askedBy.agentId === asker) : open;
      }
      if (contract.name === 'decision.agent-projects') {
        const agents = input.agents as { agentId: string; cwd: string }[];
        recorded.resolves.push(agents.map(agent => agent.agentId));
        return agents.map(agent => ({ agentId: agent.agentId, project: options.projects?.[agent.agentId] ?? null }));
      }
      if (contract.name === 'decision.answer') {
        if (options.answerError) throw options.answerError;
        recorded.answers.push(input);
        open = open.filter(entry => entry.id !== input.id);
        return decision({ id: String(input.id), status: 'answered' });
      }
      if (contract.name === 'decision.withdraw') {
        recorded.withdrawals.push(input);
        open = open.filter(entry => entry.id !== input.id);
        return decision({ id: String(input.id), status: 'withdrawn' });
      }
      throw new Error(`unexpected rpc ${contract.name}`);
    },
    addComposerPill: (contribution: PillContribution) => {
      // Paseo 0.12's button id rule.
      if (!/^[a-z][a-z0-9-]*$/.test(contribution.id)) throw new Error(`Invalid plugin button id: ${contribution.id}`);
      const pill: RecordedPill = { ...contribution, updates: [], removed: false,
        update(patch: Partial<BoardPill>) { pill.updates.push(patch); Object.assign(pill.button, patch); },
        remove() { pill.removed = true; } };
      recorded.pills.push(pill);
      return pill;
    },
    openPanel: (id: string, panelOptions: unknown) => { recorded.panels.push({ id, options: panelOptions }); },
    agents: {
      subscribe: (handler: (update: { kind: string; agent?: { id: string; workspaceId?: string }; agentId?: string }) => void) => {
        listeners.push(handler);
        return () => { listeners = listeners.filter(entry => entry !== handler); };
      },
      list: async () => ({
        entries: (options.agents ?? []).map(agent => ({ agent })),
        subscription: { release: async () => {} },
      }),
      deliver: (update: { kind: string; agent?: { id: string; workspaceId?: string }; agentId?: string }) => {
        for (const handler of listeners) handler(update);
      },
    },
  };
  return { client: client as unknown as BoardHost, recorded, deliver: client.agents.deliver, setOpen: (next: DecisionView[]) => { open = next; } };
}

const popoverProps = (over: Record<string, unknown> = {}) => ({
  theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
  context: 'agent' as const, workspaceId: 'ws-1', agentId: 'agent-asker', close: () => {}, ...over,
});

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail('the decision pill did not settle');
}

const decisionsProject = { key: 'decisions', name: 'Decisions' };

test('032-9 every known thread gets a pill with its project count and the total, labelled "N here · M all"', async () => {
  const { decisionPillLabel, decisionPills } = await ready();
  const open = [decision(), decision({ id: 'decision-2', projectKey: 'elsewhere' }), decision({ id: 'decision-3', projectKey: null })];
  const f = fakeClient({ open, projects: { 'agent-in': decisionsProject, 'agent-out': null } });
  const controller = decisionPills(f.client, 'queue-board');
  controller.know('agent-in', 'ws-1', '/fixture/decisions');
  controller.know('agent-out', 'ws-2', '/tmp');
  await controller.poll();
  assert.deepEqual(f.recorded.resolves, [['agent-in', 'agent-out']], 'one batch resolves the threads\' projects');
  const byAgent = Object.fromEntries(f.recorded.pills.map(pill => [pill.agentId, pill]));
  assert.equal(byAgent['agent-in'].id, 'operator-decisions-agent-in', 'each thread gets its own pill id, so opening one never opens another');
  assert.equal(byAgent['agent-in'].workspaceId, 'ws-1');
  assert.equal(byAgent['agent-in'].button.label, '1 here · 3 all', 'a thread in a project counts its project and all');
  assert.equal(byAgent['agent-out'].button.label, '3 decisions', 'a thread outside any project counts all');
  assert.equal(byAgent['agent-in'].button.behavior.kind, 'popover');
  assert.equal(decisionPillLabel(0, 1), '0 here · 1 all');
  assert.equal(decisionPillLabel(null, 1), '1 decision');

  f.setOpen([decision(), decision({ id: 'decision-4' })]);
  await controller.poll();
  assert.equal(f.recorded.pills.length, 2, 'a change relabels the pills instead of adding more');
  assert.equal(byAgent['agent-in'].button.label, '2 here · 2 all');
  assert.equal(f.recorded.resolves.length, 1, 'resolved projects are cached');
});

test('032-9 the pills are removed when the last open decision closes, and return if another opens', async () => {
  const { decisionPills } = await ready();
  const f = fakeClient({ open: [decision()], projects: { 'agent-in': decisionsProject } });
  const controller = decisionPills(f.client, 'queue-board');
  controller.know('agent-in', 'ws-1');
  await controller.poll();
  const pill = f.recorded.pills[0];
  f.setOpen([]);
  await controller.poll();
  assert.equal(pill.removed, true);
  assert.equal(controller.pills.size, 0, 'no pill stays while no decision is open');
  f.setOpen([decision({ id: 'decision-4' })]);
  await controller.poll();
  assert.equal(controller.pills.size, 1, 'a new open decision registers a pill again');
  assert.notEqual(f.recorded.pills.at(-1), pill, 'the removed registration is not reused');
});

test('032-9 a pill needs the thread\'s workspace and follows agent removal; projects are re-resolved after the refresh interval', async () => {
  const { decisionPills, DECISION_PILL_PROJECT_REFRESH_MS } = await ready();
  let now = 0;
  const f = fakeClient({ open: [decision()], projects: { 'agent-in': decisionsProject } });
  const controller = decisionPills(f.client, 'queue-board', () => now);
  controller.know('agent-bare', null);
  await controller.poll();
  assert.equal(f.recorded.pills.length, 0, 'no pill without a workspace');
  controller.know('agent-in', 'ws-1');
  await controller.poll();
  const first = f.recorded.pills[0];
  assert.equal(first.agentId, 'agent-in');
  controller.forget('agent-in');
  assert.equal(first.removed, true);
  await controller.poll();
  assert.equal(f.recorded.pills.length, 1, 'no pill returns for a forgotten agent');
  controller.know('agent-in', 'ws-1');
  await controller.poll();
  now += DECISION_PILL_PROJECT_REFRESH_MS;
  await controller.poll();
  assert.deepEqual(f.recorded.resolves, [['agent-in'], ['agent-in'], ['agent-in']], 'a forgotten thread and the refresh interval both resolve again');
});

test('032-9 one shared read per refresh drives the pills; a slow read never stacks into a burst', async () => {
  const { decisionPills } = await ready();
  const f = fakeClient({ open: [decision()], projects: { 'agent-in': decisionsProject } });
  const controller = decisionPills(f.client, 'queue-board');
  controller.know('agent-in', 'ws-1');
  await Promise.all([controller.poll(), controller.poll(), controller.poll()]);
  assert.equal(f.recorded.lists, 1, 'overlapping polls collapse into the one read in flight');
  assert.equal(f.recorded.pills.length, 1);
});

test('032-9 registerDecisionPills seeds the agents with their working directories, registers the pills and cleans up', async () => {
  const { registerDecisionPills } = await ready();
  const f = fakeClient({ agents: [{ id: 'agent-in', workspaceId: 'ws-1', cwd: '/fixture/decisions' }, { id: 'agent-bare' }], open: [decision()],
    projects: { 'agent-in': decisionsProject } });
  const cleanup = registerDecisionPills(f.client, 'queue-board');
  try {
    await settle(() => f.recorded.lists >= 1 && f.recorded.pills.length === 1);
    const pill = f.recorded.pills[0];
    assert.equal(pill.agentId, 'agent-in');
    assert.equal(pill.button.label, '1 here · 1 all');
    assert.equal(f.recorded.pills.some(entry => entry.agentId === 'agent-bare'), false, 'an agent without a workspace id never gets a pill');
    f.deliver({ kind: 'remove', agentId: 'agent-in' });
    await settle(() => pill.removed);
  } finally { cleanup(); }
});

test('032-9 the popover switches between this project and all, starting on the project when it has any', async () => {
  const { decisionPillPopover } = await ready();
  const open = [decision({ id: 'here', question: 'Here question?' }), decision({ id: 'there', question: 'There question?', projectKey: 'elsewhere' })];
  const f = fakeClient({ open });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board', known: () => open, projectOf: () => decisionsProject });
  const view = mount(h(Popover as never, popoverProps() as never));
  await settle(() => view.text().includes('Here question?'));
  assert.ok(!view.text().includes('There question?'), 'the project scope hides other projects');
  assert.ok(view.text().includes('Decisions (1)') && view.text().includes('All (2)'));
  view.press(/Show all decisions/);
  await settle(() => view.text().includes('There question?'));

  const Elsewhere = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board', known: () => [open[1]], projectOf: () => decisionsProject });
  const empty = mount(h(Elsewhere as never, popoverProps() as never));
  await settle(() => empty.text().includes('There question?') && empty.text().includes('All (2)'));
  assert.ok(empty.text().includes('All (2)'), 'with nothing in its project the popover starts on All');
});

test('032-9 the popover shows the compact choices and answers with operator authority', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision()] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  assert.match(ui.text(), /main/);
  assert.match(ui.text(), /Recommended/);

  ui.type(/Answer box: Which branch do we cut\?/, 'Cut from main.');
  ui.press(/Answer decision: Which branch do we cut\?/);
  await settle(() => ui.text().includes('No open decisions.'));
  assert.deepEqual(f.recorded.answers, [{
    id: 'decision-1', version: 1, answer: 'Cut from main.',
    answeredBy: 'operator (board)', relayed: false, note: '',
  }], 'the popover answers as the operator, never as a relay');
});

test('032-9 the popover leaves missing choices empty instead of inventing consequences', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision({ choices: undefined, options: [], recommended: undefined })] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  assert.doesNotMatch(ui.text(), /Choose this direction|Accept the proposed direction/);
  assert.equal(ui.text().includes('main'), false, 'no choice row is rendered when the record has no choices');
});

test('032-9 the popover labels a decision without a project as General', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision({ askedBy: { agentId: 'agent-asker', project: null } })] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  assert.match(ui.text(), /General/);
  ui.update(h('View', null));
});

test('032-9 an option fills the answer box and asks before replacing a written answer', async () => {
  // Tom, 2026-09-29: options should pre-fill the answer; a written answer is confirmed first.
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision()] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  const box = /Answer box: Which branch do we cut\?/;
  ui.press(/^Use option: main/);
  await settle(() => ui.query(box)?.props.value === 'main');
  assert.equal(ui.query('Replace your answer?'), undefined, 'an empty or matching box fills without asking');
  ui.type(box, 'Cut from a release branch instead.');
  ui.press('Use option: branch');
  await settle(() => ui.query('Replace your answer?') !== undefined);
  ui.press('Keep mine');
  await settle(() => ui.query('Replace your answer?') === undefined);
  assert.equal(ui.query(box)?.props.value, 'Cut from a release branch instead.');
  ui.press('Use option: branch');
  await settle(() => ui.query('Replace your answer?') !== undefined);
  ui.press('Replace');
  await settle(() => ui.query(box)?.props.value === 'branch');
});

test('032-9 a failed answer surfaces the error and reloads the decision', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision()], answerError: new Error('Decision changed to version 2; reload before saving') });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  ui.type(/Answer box: Which branch do we cut\?/, 'Cut from main.');
  ui.press(/Answer decision: Which branch do we cut\?/);
  await settle(() => ui.text().includes('Decision changed to version 2'));
  assert.equal(f.recorded.answers.length, 0);
  assert.equal(f.recorded.lists >= 2, true, 'the popover re-reads after a refused answer');
});

test('032-9 the popover links to the board view and closes', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision()] });
  let closed = false;
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps({ close: () => { closed = true; } }) as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  ui.press('Open the decisions board');
  assert.deepEqual(f.recorded.panels, [{ id: 'queue-board', options: { workspaceId: 'ws-1' } }]);
  assert.equal(closed, true);
});

test('032-9 the popover opens with the pills\' last read, not a loading line', async () => {
  // Tom, 2026-09-30: the popover opened at "Loading…" size and was left about 80 px tall
  // once the decisions arrived. The first frame must already hold the decisions.
  const { decisionPills } = await ready();
  const f = fakeClient({ open: [decision()] });
  const controller = decisionPills(f.client, 'queue-board');
  controller.know('agent-asker', 'ws-1');
  controller.reconcile([decision()]);
  const ui = mount(h(controller.Popover as never, popoverProps() as never));
  assert.match(ui.text(), /Which branch do we cut\?/, 'the first render shows the known decision');
  assert.doesNotMatch(ui.text(), /Loading…/);
  controller.stop();
});

test('032-9 the popover marks the recommended choice and keeps the answer box after the options', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision()] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  const text = ui.text();
  const recommended = text.indexOf('Recommended');
  const nextOption = text.indexOf('branch — Start from the feature branch.');
  assert.ok(recommended >= 0 && nextOption > recommended, 'the recommended option is first and marked');
  assert.ok(ui.query(/Answer box:/), 'the answer box remains available after the choices');
  assert.ok(ui.query(/^Use option: main/), 'options render as rows');
  assert.ok(ui.text().includes('Recommended'), 'the recommended option is tagged');
  ui.press(/^Use option: main/);
  await settle(() => ui.query(/^Use option: main/)?.props.accessibilityState?.selected === true);
  assert.equal(ui.query(/Answer box: Which branch do we cut\?/)?.props.value, 'main');
});

test('032-9 compact details stay collapsed and an overtaken decision links its ruling and withdraws in one click', async () => {
  const { decisionPillPopover } = await ready();
  const ref = { kind: 'brief_amendment' as const, id: 'task-9', label: 'Brief amendment for task-9: scope settled', at: '2026-11-02T10:00:00Z' };
  const f = fakeClient({ open: [decision({ details: 'Evidence: src/api.ts:42 and inode 9.', overtakenBy: [ref],
    links: { tasks: ['task-9'], leads: [], papercuts: [] } })] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board' });
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes('Which branch do we cut?'));
  assert.match(ui.text(), /Task · task-9/);
  assert.ok(ui.text().indexOf('Recommended') < ui.text().indexOf('branch — Start from the feature branch.'));
  assert.doesNotMatch(ui.text(), /Evidence: src\/api/);
  assert.match(ui.text(), /Probably overtaken/);
  assert.match(ui.text(), /Brief amendment for task-9/);
  ui.press(/Open citing ruling:/);
  assert.deepEqual(f.recorded.panels, [{ id: 'queue-board', options: { workspaceId: 'ws-1' } }]);
  ui.press(/Show details for Which branch do we cut/);
  await settle(() => ui.text().includes('Evidence: src/api.ts:42'));
  ui.press('Withdraw');
  await settle(() => ui.text().includes('No open decisions.'));
  assert.deepEqual(f.recorded.withdrawals, [{ id: 'decision-1', version: 1,
    reason: 'Withdrawn after Brief amendment for task-9: scope settled', withdrawnBy: 'operator (board)' }]);
});

test('032-9 on Paseo 0.12 the pills follow the list subscription\'s snapshot and agent_update messages, with no legacy agents.subscribe', async () => {
  const { registerDecisionPills } = await ready();
  const base = fakeClient({ open: [decision()], projects: { 'agent-a': decisionsProject, 'agent-b': decisionsProject, 'agent-c': decisionsProject } });
  let handlers: { snapshot: (s: { entries: { agent: { id: string; workspaceId?: string; cwd?: string } }[] }) => void; update: (m: { type: string; payload: unknown }) => void } | null = null;
  let released = false;
  const client = { ...base.client, agents: {
    list: async () => ({ subscription: { subscribe: (h: typeof handlers) => { handlers = h; }, release: async () => { released = true; } } }),
  } } as unknown as BoardHost;
  const cleanup = registerDecisionPills(client, 'queue-board');
  try {
    await settle(() => handlers !== null);
    handlers!.snapshot({ entries: [{ agent: { id: 'agent-a', workspaceId: 'ws-1', cwd: '/fixture/decisions' } }, { agent: { id: 'agent-b', workspaceId: 'ws-1' } }] });
    await settle(() => base.recorded.pills.length === 2);
    assert.deepEqual(base.recorded.pills.map(pill => pill.agentId).sort(), ['agent-a', 'agent-b']);
    assert.equal(base.recorded.pills[0].button.label, '1 here · 1 all');
    handlers!.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'agent-b' } });
    assert.equal(base.recorded.pills.find(pill => pill.agentId === 'agent-b')!.removed, true, 'a removed agent loses its pill');
    handlers!.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { id: 'agent-c', workspaceId: 'ws-2' } } });
    handlers!.update({ type: 'other', payload: {} });
    // A reconnect snapshot is the whole set: an agent it no longer names loses its pill.
    handlers!.snapshot({ entries: [{ agent: { id: 'agent-c', workspaceId: 'ws-2' } }] });
    await settle(() => base.recorded.pills.some(pill => pill.agentId === 'agent-c' && !pill.removed));
    assert.equal(base.recorded.pills.find(pill => pill.agentId === 'agent-a')!.removed, true);
  } finally { cleanup(); }
  assert.equal(released, true, 'cleanup releases the list subscription');
});

test('032-9 a failed first agent listing is retried on the refresh tick, so pills still appear (Sol, #581)', async () => {
  const { registerDecisionPills } = await ready();
  const base = fakeClient({ open: [decision()], projects: { 'agent-a': decisionsProject } });
  let calls = 0;
  let handlers: { snapshot: (s: { entries: { agent: { id: string; workspaceId?: string } }[] }) => void; update: (m: { type: string; payload: unknown }) => void } | null = null;
  const client = { ...base.client, agents: {
    list: async () => {
      calls++;
      if (calls === 1) throw new Error('host reconnecting');
      return { subscription: { subscribe: (h: typeof handlers) => { handlers = h; }, release: async () => {} } };
    },
  } } as unknown as BoardHost;
  const cleanup = registerDecisionPills(client, 'queue-board', 20);
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls, 2, 'the listing is retried once, then stops after it succeeds');
    handlers!.snapshot({ entries: [{ agent: { id: 'agent-a', workspaceId: 'ws-1' } }] });
    await settle(() => base.recorded.pills.length === 1);
  } finally { cleanup(); }
});

test('032-9 the pill reports its state to the console once per change, and a failing refresh with its error', async () => {
  const { decisionPills, pillLogger } = await ready();
  const lines: Array<[string, unknown]> = [];
  const report = pillLogger((message, detail) => { lines.push([message, detail]); });
  const f = fakeClient({ open: [decision()], projects: { 'agent-a': decisionsProject } });
  const controller = decisionPills(f.client, 'queue-board', Date.now, report);
  controller.know('agent-a', 'ws-1');
  await controller.poll();
  await controller.poll();
  assert.deepEqual(lines.map(([message]) => message), ['1 open decision(s), 1 thread(s) known, 1 resolved, 1 pill(s) registered'], 'an unchanged state is not repeated');
  const failing = { ...f.client, rpc: async () => { throw new Error('Queue unreachable'); } } as unknown as BoardHost;
  const broken = decisionPills(failing, 'queue-board', Date.now, report);
  await broken.poll();
  assert.equal(lines.at(-1)![0], 'refresh failed: Queue unreachable');
  assert.ok(lines.at(-1)![1] instanceof Error);
});

test('032-9 a steady listing failure beside a steady refresh is reported once each, not every tick (Sol, #583)', async () => {
  const { pillLogger } = await ready();
  const lines: string[] = [];
  const report = pillLogger(message => { lines.push(message); });
  for (let tick = 0; tick < 3; tick++) { report('listing', 'agent listing failed: offline', new Error('offline')); report('refresh', '1 open decision(s), 0 thread(s) known, 0 resolved, 0 pill(s) registered'); }
  assert.deepEqual(lines, ['agent listing failed: offline', '1 open decision(s), 0 thread(s) known, 0 resolved, 0 pill(s) registered']);
});

test('032-9 pill ids pass Paseo 0.12\'s button id rule, and one refused pill never stops the rest (Tom, 2026-10-21)', async () => {
  const { decisionPillId, decisionPills, pillLogger } = await ready();
  const rule = /^[a-z][a-z0-9-]*$/;
  for (const agentId of ['26afd3bb-84b4-4c80-aef5-52be50cb161e', 'Agent_X:1']) assert.match(decisionPillId(agentId), rule);
  const lines: string[] = [];
  const f = fakeClient({ open: [decision()], projects: { 'agent-a': decisionsProject, 'agent-b': decisionsProject } });
  const strict = { ...f.client, addComposerPill: (contribution: { id: string; agentId: string }) => {
    if (contribution.agentId === 'agent-a') throw new Error('Plugin composer pill refused');
    if (!rule.test(contribution.id)) throw new Error(`Invalid plugin button id: ${contribution.id}`);
    return (f.client as unknown as { addComposerPill: (c: unknown) => unknown }).addComposerPill(contribution);
  } } as unknown as BoardHost;
  const controller = decisionPills(strict, 'queue-board', Date.now, pillLogger(message => { lines.push(message); }));
  controller.know('agent-a', 'ws-1'); controller.know('agent-b', 'ws-1');
  await controller.poll();
  assert.deepEqual(f.recorded.pills.map(pill => pill.agentId), ['agent-b'], 'agent-b registers despite agent-a');
  assert.ok(lines.some(line => line === 'pill for agent-a refused: Plugin composer pill refused'));
});

test('032-9 the popover fills Paseo\'s popover box instead of sizing itself from the window (Tom, 2026-10-21)', async () => {
  const { decisionPillPopover } = await ready();
  const f = fakeClient({ open: [decision()] });
  const Popover = decisionPillPopover({ client: f.client, boardPanelId: 'queue-board', known: () => [decision()] });
  const ui = mount(h(Popover as never, popoverProps() as never));
  const root = ui.ofType('View')[0];
  assert.equal((root.props.style as { width?: unknown }).width, '100%', 'no fixed width the host would clip');
});

test('1030 the pills reread decisions only when the decisions revision moves, not on every board revision', async () => {
  const { decisionPills } = await ready();
  const { clearDecisionRead } = await import('../client/decision-read');
  clearDecisionRead();
  const f = fakeClient({ open: [decision()], projects: { 'agent-in': decisionsProject } });
  let revision = 5, decisions = 1;
  const rpc = f.client.rpc.bind(f.client);
  (f.client as unknown as { rpc: typeof rpc }).rpc = (async (contract: { name: string }, input: Record<string, unknown>) => {
    if (contract.name !== 'queue.ui-snapshot') return rpc(contract as never, input as never);
    if (input.revision === revision) return { unchanged: true, revision, connected: true, paused: false, quiet: true, activeWorkers: 0, unsettled: 0, error: '', stoppedThreads: 0, resumedThreads: 0 };
    return { revision, planning: { leads: 1, decisions, plans: 1 } };
  }) as typeof rpc;
  const controller = decisionPills(f.client, 'queue-board');
  controller.know('agent-in', 'ws-1', '/fixture/decisions');
  await controller.poll();
  assert.equal(f.recorded.lists, 1);
  await controller.poll();
  revision++; await controller.poll();
  revision++; await controller.poll();
  assert.equal(f.recorded.lists, 1, 'acknowledgements and unrelated board revisions reuse the decision read');
  f.setOpen([decision(), decision({ id: 'decision-2' })]);
  revision++; decisions++; await controller.poll();
  assert.equal(f.recorded.lists, 2, 'a decision write rereads at once');
  assert.equal(f.recorded.pills[0].button.label, '2 here · 2 all');
  controller.stop();
  clearDecisionRead();
});
