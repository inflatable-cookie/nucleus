import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { laneViewSchema, projectSchema } from '../shared/contracts';
import type { LaneView, Project, ProjectPlan } from '../shared/contracts';
import type { PlanEdit } from '../client/planning-panel';

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const repoA = { origin: 'owner/app', path: '/app' };

const plainLaneRecord = (key: string, escalated: boolean) => ({
  id: `lane-${key}`, key, title: `${key === 'alpha' ? 'Alpha' : 'Beta'} lane`, aim: `Done looks like ${key} shipped.`, status: 'active', note: '',
  repositories: [repoA], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', closedAt: null,
  ...(key === 'alpha' ? { drain: { since: '2026-10-02T08:00:00.000Z', notices: 1, lastNoticeAt: '2026-10-02T08:00:00.000Z', ...(escalated ? { escalatedAt: '2026-10-03T08:00:00.000Z' } : {}) }, keep: null } : {}),
});
const drainedLane = (escalated: boolean) => laneViewSchema.parse({
  id: 'lane-1', key: 'alpha', title: 'Alpha lane', aim: 'Done looks like alpha shipped.', status: 'active', note: '',
  repositories: [repoA], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', closedAt: null,
  drain: { since: '2026-10-02T08:00:00.000Z', notices: 1, lastNoticeAt: '2026-10-02T08:00:00.000Z', ...(escalated ? { escalatedAt: '2026-10-03T08:00:00.000Z' } : {}) },
  keep: null, liveByPhase: {}, liveByRepository: {}, terminalCount: 3, lastActivityAt: '2026-10-02T08:00:00.000Z',
  recentOutcomes: [{ taskId: 't1', title: 'Finished task', outcome: 'done', prUrl: null, prNumber: null, finishedAt: '2026-10-02T08:00:00.000Z' }],
});
const plainLane = laneViewSchema.parse({
  id: 'lane-2', key: 'beta', title: 'Beta lane', aim: 'Done looks like beta shipped.', status: 'active', note: '',
  repositories: [repoA], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z', closedAt: null,
  liveByPhase: { working: 1 }, liveByRepository: { '/app': 1 }, terminalCount: 0, lastActivityAt: '2026-10-03T00:00:00.000Z',
});
const project = (drain: LaneView['drain']): Project => projectSchema.parse({
  key: 'app', name: 'App', version: 1, repositories: [repoA], primary: repoA, owner: { agentId: 'thread', assignedBy: 'operator', assignedAt: '2026-10-03T00:00:00.000Z', note: '' }, ...(drain ? { drain } : {}),
});
const plan: ProjectPlan = {
  project: 'app', version: 1, author: 'planner-agent', createdAt: '2026-10-01T00:00:00.000Z',
  entries: [{ lane: 'alpha', note: '', horizon: 'now', doneWhen: 'Alpha shipped' }],
};

async function settle(probe: () => boolean, what = 'the surface did not settle') {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(what);
}

test('041 rendered: a drained plan lane shows the Drained flag with its age in the Now band', async () => {
  const { PlanningTab } = await import('../client/planning-panel');
  function Harness() {
    const [edits, setEdits] = useState<Record<string, PlanEdit>>({});
    return h(PlanningTab, {
      sections: [{ project: project(null), latest: plan, saved: plan }],
      lanes: [drainedLane(false), plainLane], edits, selectedLane: '', step: 'plan', compact: false, busy: false, lanePanel: null,
      onStep: () => {}, onOpenLane: () => {}, onEdit: (p: string, edit: PlanEdit) => setEdits(prev => ({ ...prev, [p]: edit })),
      onSave: () => {}, onCancel: () => {}, c,
    });
  }
  const ui = mount(h(Harness));
  assert.ok(ui.get('Drained alpha'));
  assert.match(ui.text(), /Drained · .* ago/);
});

test('Spec 041 rows 7 and 8 rendered: an escalated drained lane is answered on the pipeline Decisions column; Keep needs a reason and Keep clears the item', async () => {
  const queue = await import('../client/queue');
  const escalated = { lane: true, project: true };
  const calls: Array<{ method: string; input: unknown }> = [];
  const board = (revision: number) => ({
    revision, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, occupiedSlots: 0,
    globalLimit: 32, projectLimit: 5, stallThresholdMinutes: 20, holdReminderMinutes: 120, holdEscalationMinutes: 240, laneDrainMinutes: 120, laneDrainEscalationMinutes: 1440, hostOutageNoticeMinutes: 120,
    tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
    lanes: [drainedLane(escalated.lane), plainLane], projects: [project(escalated.project ? { since: '2026-10-02T08:00:00.000Z', notices: 1, lastNoticeAt: '2026-10-02T08:00:00.000Z', escalatedAt: '2026-10-03T08:00:00.000Z' } : null)], prStates: {},
  });
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return board(escalated.lane || escalated.project ? 1 : 1000);
    if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
    if (method === 'lane.keep') { calls.push({ method, input }); escalated.lane = false; return plainLaneRecord('alpha', false); }
    if (method === 'lane.status') { calls.push({ method, input }); escalated.lane = false; return plainLaneRecord('alpha', false); }
    if (method === 'lead.board') return { cards: [], links: [] };
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
    if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
    return {};
  };
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
  const tree = mount(h(QueryClientProvider, { client: new QueryClient(), children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }) }));
  await settle(() => tree.text().includes('Alpha lane has drained'), 'the escalated lane card on the Decisions column');
  assert.doesNotMatch(tree.text(), /board is drained/, 'a drained board never joins the Decisions column (Tom, 2026-10-15)');
  // Keep needs a reason: the confirm button stays disabled until one is typed.
  tree.press('Keep drained lane alpha');
  assert.equal(tree.get('Confirm keep for drained lane alpha').props.disabled, true);
  tree.type('Why keep Alpha lane (required)', 'Briefs land next week');
  assert.notEqual(tree.get('Confirm keep for drained lane alpha').props.disabled, true);
  tree.press('Confirm keep for drained lane alpha');
  await settle(() => calls.some(call => call.method === 'lane.keep'));
  assert.deepEqual(calls.find(call => call.method === 'lane.keep')!.input, { key: 'alpha', reason: 'Briefs land next week', author: 'operator (board)' });
  await settle(() => !tree.text().includes('Alpha lane has drained'));
});

test('Spec 041 rendered: Close from the Decisions column finishes the drained lane', async () => {
  const queue = await import('../client/queue');
  let escalated = true;
  const calls: Array<{ method: string; input: unknown }> = [];
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return {
      revision: escalated ? 1 : 1000, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, occupiedSlots: 0,
      globalLimit: 32, projectLimit: 5, stallThresholdMinutes: 20, holdReminderMinutes: 120, holdEscalationMinutes: 240, laneDrainMinutes: 120, laneDrainEscalationMinutes: 1440, hostOutageNoticeMinutes: 120,
      tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
      lanes: [drainedLane(escalated), plainLane], projects: [project(null)], prStates: {},
    };
    if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
    if (method === 'lane.status') { calls.push({ method, input }); escalated = false; return plainLaneRecord('alpha', false); }
    if (method === 'lead.board') return { cards: [], links: [] };
    if (method === 'plans' || method === 'papercut.list' || method === 'draft.list' || method === 'decision.list') return [];
    if (method === 'project.qa.list' || method === 'host.run.list' || method === 'host.run.board') return [];
    return {};
  };
  const surfaceProps = { theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };
  const tree = mount(h(QueryClientProvider, { client: new QueryClient(), children: h(PluginRpcProvider, { invoke, children: h(queue.MainSurface as never, surfaceProps) }) }));
  await settle(() => tree.text().includes('Alpha lane has drained'), 'the escalated lane card on the Decisions column');
  tree.press('Close drained lane alpha');
  await settle(() => calls.length === 1);
  assert.deepEqual(calls[0]!.input, { key: 'alpha', status: 'done' });
  await settle(() => !tree.text().includes('Alpha lane has drained'));
});
