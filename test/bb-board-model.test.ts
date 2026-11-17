/**
 * Spec 062, phase 6 acceptance: the rail badge, the board's sub-path routes, which
 * thread gets which tab, and the planner rows' link to their project's board.
 *
 * The badge reads task summaries projected from a real `Store` the way the board
 * snapshot carries them; the tab and link decisions read the sidebar projection
 * the service serves (`readBbSidebarGroups` over real stored projects), and the
 * registrations are the ones `registerNucleusBoard` makes on a recorded plugin app.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import React from 'react';
import { mount, useNativeStubs } from './support/render';
import { Store } from '../core/store/store';
import { taskWaitStateContext } from '../core/recovery/wait-context';
import { visibleTaskSummaries } from '../shared/task-view';
import { submissionSchema, type TaskSummary } from '../shared/contracts';
import { readBbSidebarGroups } from '../core/runtime/bb-sidebar-groups';
import { bbSidebarGroupsOutputSchema } from '../shared/schema/bb-sidebar';
import { parseBoardSubPath, projectSubPath, railBadge, sidebarIndex, taskNeedsOperator } from '../hosts/bb/client/model';
import { projectBoardHref } from '../hosts/bb/plugin/sidebar-groups';

useNativeStubs();

const hostId = 'bb:' + 'c'.repeat(64);
const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bb-board-model-'));
const store = new Store(join(directory, 'queue.sqlite'));
after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

store.upsertProject({ key: 'synthetic', name: 'Synthetic', repositories: [{ origin: null, path: '/synthetic/repo' }, { origin: null, path: '/synthetic/other' }], primary: { origin: null, path: '/synthetic/repo' } });
store.upsertProject({ key: 'elsewhere', name: 'Elsewhere', repositories: [{ origin: null, path: '/synthetic/elsewhere' }] });
store.setProjectPlanner({ key: 'synthetic', agentId: 'thr_planner', setBy: 'operator' });
store.registerProjectAgent({ key: 'synthetic', name: 'lead', purpose: 'Leads the lane', agentId: 'thr_lead', hostId, registeredBy: 'operator' });

function seed(title: string, phase: Parameters<Store['update']>[1]['phase'], repoPath = '/synthetic/repo'): TaskSummary {
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath, planningCommit: 'a'.repeat(40), handoffPath: '/synthetic/handoff.md', originAgentId: 'thr_planner' }), hostId, '/synthetic/handoff.md', 'a'.repeat(40));
  store.update(task.id, { phase });
  const stored = store.task(task.id);
  return visibleTaskSummaries([stored], store.projects(), [], new Map(), new Map([[stored.id, taskWaitStateContext(store, stored, null)]]))[0]!;
}

test('the rail badge counts the tasks that need the operator, carries its tone and label, and drains as they settle', () => {
  const working = seed('Working quietly', 'working');
  const blocked = seed('Blocked on a fault', 'blocked');
  const attention = seed('Needs attention', 'needs_attention');
  const asking = { ...seed('Asking a question', 'working'), questionAgentIds: ['thr_worker'] };
  const escalated = { ...working, id: `${working.id}-escalated`, resolution: { ...working.resolution, escalated: true } };
  // A finished task leaves the board's live summaries; the badge must ignore one that lingers.
  const done = { ...blocked, id: `${blocked.id}-done`, phase: 'done' as const };

  assert.equal(taskNeedsOperator(working), false);
  assert.equal(railBadge([working, done]), null, 'nothing needing the operator draws no badge');

  const full = railBadge([working, blocked, attention, asking, escalated, done]);
  assert.deepEqual(full, { count: 4, tone: 'critical', label: '4 tasks need you' });

  // Only an escalated hold left: still counted, but a warning rather than critical.
  assert.deepEqual(railBadge([working, escalated]), { count: 1, tone: 'warning', label: '1 task needs you' });
  // The question answered and the faults settled: the badge drains to nothing.
  assert.equal(railBadge([working, { ...asking, questionAgentIds: [] }, { ...blocked, phase: 'done' as const }]), null);
});

test("the panel's sub-path routes the global board, a project's board by its Nucleus key, and Settings", () => {
  assert.deepEqual(parseBoardSubPath(''), { kind: 'board' });
  assert.deepEqual(parseBoardSubPath('settings'), { kind: 'settings' });
  assert.deepEqual(parseBoardSubPath('project/synthetic'), { kind: 'project', key: 'synthetic' });
  assert.deepEqual(parseBoardSubPath('project/a%20key'), { kind: 'project', key: 'a key' });
  assert.deepEqual(parseBoardSubPath('project'), { kind: 'unknown', subPath: 'project' });
  assert.deepEqual(parseBoardSubPath('project/%E0%A4%A'), { kind: 'unknown', subPath: 'project/%E0%A4%A' });
  assert.equal(projectSubPath('synthetic'), 'project/synthetic');
  // The forked sidebar's project rows link to the same route, by the same key.
  assert.equal(projectBoardHref('synthetic'), '/plugins/nucleus/board/project/synthetic');
});

function sidebarRead() {
  const task = store.liveTasks()[0]!;
  return bbSidebarGroupsOutputSchema.parse(readBbSidebarGroups({
    liveTasks: () => store.liveTasks(),
    summaries: () => [],
    workspaces: () => ({ handle: { environmentId: 'env_task', projectId: 'proj_other', repositoryRoot: '/synthetic/other' } }),
    threads: () => ({ agents: { thr_worker: { id: 'thr_worker', task: task.id, role: 'worker' }, thr_reviewer: { id: 'thr_reviewer', task: task.id, role: 'reviewer' } } }),
    prStates: {},
    projects: () => store.projects(),
  }));
}

test('the per-project tab shows on the project planner and named-agent threads only; the task tab on role threads only', async () => {
  const read = sidebarRead();
  // Role threads ride the read only for groups with an attached environment; build the
  // index from the served projects plus the recorded role threads the read names.
  const index = sidebarIndex({ ...read, threads: [{ threadId: 'thr_worker', taskId: 'task_1', role: 'worker', environmentId: 'env_task' }, { threadId: 'thr_reviewer', taskId: 'task_1', role: 'reviewer', environmentId: 'env_task' }] });
  assert.equal(index.projectForThread('thr_planner')?.key, 'synthetic');
  assert.equal(index.projectForThread('thr_lead')?.key, 'synthetic');
  for (const threadId of ['thr_worker', 'thr_reviewer', 'thr_random']) assert.equal(index.projectForThread(threadId), null, `${threadId} gets no project tab`);
  assert.deepEqual(index.taskForThread('thr_worker'), { taskId: 'task_1', role: 'worker' });
  assert.deepEqual(index.taskForThread('thr_reviewer'), { taskId: 'task_1', role: 'reviewer' });
  for (const threadId of ['thr_planner', 'thr_lead', 'thr_random']) assert.equal(index.taskForThread(threadId), null, `${threadId} gets no task tab`);
  // A BB project row resolves to the Nucleus project that owns its repository.
  assert.equal(index.projectForBbProject('proj_other')?.key, 'synthetic');
  assert.equal(index.projectForBbProject('proj_unknown'), null);

  // The same decisions through the registrations BB calls.
  const surfaces = await import('../hosts/bb/client/surfaces');
  const registered: Record<string, any> = {};
  const app = {
    slots: {
      navPanel: (registration: { id: string }) => { registered[registration.id] = registration; },
      experimental_tab: (registration: { id: string }) => { registered[registration.id] = registration; },
      settingsSection: (registration: { id: string }) => { registered[registration.id] = registration; },
      pendingInteraction: (registration: { id: string }) => { registered[registration.id] = registration; },
      experimental_appOverlay: (registration: { id: string }) => { registered[registration.id] = registration; },
      experimental_threadAction: (registration: { id: string }) => { registered[`action:${registration.id}`] = registration; },
    },
    composer: { customize: (registration: { id: string }) => { registered[`composer:${registration.id}`] = registration; } },
  };
  const served = { ...read, threads: [{ threadId: 'thr_worker', taskId: 'task_1', role: 'worker', environmentId: 'env_task' }] };
  const rpc = { call: async (_method: string, input: { method: string }) => { if (input.method === 'bb.sidebar-groups') return served; throw new Error(`${input.method} is not served here`); } };
  const sdk = { useRpc: () => rpc, useRealtime() {}, useBbNavigate: () => ({ toPluginPanel() {}, toThread() {} }), useComposer: () => ({ scope: { kind: 'new-thread', projectId: null }, experimental_openPopup: () => false, experimental_closePopup: () => false }), experimental_Icon: () => null };
  const runtime = surfaces.registerNucleusBoard(app as never, sdk as never);
  /** Each tab's own `useVisible` hook, run under the test renderer as BB runs it. */
  const visible = async (id: string, threadId: string) => {
    const Probe = () => { const shown = registered[id].useVisible({ threadId, environment: null }); return React.createElement('Text', null, runtime.sidebar.get() === null ? 'loading' : String(shown)); };
    const tree = mount(React.createElement(Probe));
    for (let attempt = 0; attempt < 200 && tree.text().includes('loading'); attempt++) { await new Promise(resolve => setTimeout(resolve, 2)); tree.update(React.createElement(Probe)); }
    return tree.text().trim() === 'true';
  };
  assert.equal(registered[surfaces.PROJECT_TAB_ID].context.kind, 'thread');
  assert.equal(registered[surfaces.PROJECT_TAB_ID].availability, 'fixed');
  assert.equal(registered[surfaces.TASK_TAB_ID].availability, 'fixed');
  assert.equal(await visible(surfaces.PROJECT_TAB_ID, 'thr_planner'), true);
  assert.equal(await visible(surfaces.PROJECT_TAB_ID, 'thr_lead'), true);
  assert.equal(await visible(surfaces.PROJECT_TAB_ID, 'thr_worker'), false);
  assert.equal(await visible(surfaces.PROJECT_TAB_ID, 'thr_random'), false);
  assert.equal(await visible(surfaces.TASK_TAB_ID, 'thr_worker'), true);
  assert.equal(await visible(surfaces.TASK_TAB_ID, 'thr_planner'), false);
  assert.equal(await visible(surfaces.TASK_TAB_ID, 'thr_random'), false);
  assert.equal(typeof registered['nucleus-board'].experimental_useBadge, 'function', 'the rail panel carries the badge hook');

  // The planner rows' "Project board" action navigates to the project's route by its key.
  const action = registered[`action:${surfaces.PROJECT_BOARD_ACTION_ID}`];
  const navigations: unknown[] = [];
  const navigate = { toPluginPanel: (path: string, options?: unknown) => { navigations.push({ path, options }); } };
  const data = sidebarIndex(runtime.sidebar.get());
  const item = action.item({ thread: { id: 'thr_planner' }, data, navigate });
  assert.equal(item.label, 'Project board');
  item.run();
  assert.deepEqual(navigations, [{ path: 'board', options: { subPath: 'project/synthetic' } }]);
  assert.equal(action.item({ thread: { id: 'thr_worker' }, data, navigate }), null, 'a role thread has no project-board action');
  assert.equal(action.item({ thread: { id: 'thr_random' }, data, navigate }), null, 'a thread Nucleus does not own has none');
  runtime.sidebar.reset();
});

test("BB's own registration collector accepts every phase-6 surface, with no warning", async () => {
  const { definePluginApp } = await import('@get-bb/plugin-sdk/app');
  const { collectPluginAppRegistrations } = await import('@get-bb/plugin-sdk/internal/plugin-app-collector');
  const surfaces = await import('../hosts/bb/client/surfaces');
  const sdk = { useRpc: () => ({ call: async () => null }), useRealtime() {}, useBbNavigate: () => ({ toPluginPanel() {}, toThread() {} }), useComposer: () => ({ scope: { kind: 'new-thread', projectId: null }, experimental_openPopup: () => false, experimental_closePopup: () => false }), experimental_Icon: () => null };
  const warnings: string[] = [];
  const collected = collectPluginAppRegistrations(definePluginApp(app => { surfaces.registerNucleusBoard(app as never, sdk as never); }), message => warnings.push(message));
  assert.deepEqual(warnings, []);
  assert.deepEqual(collected.navPanels.map(panel => [panel.id, panel.path, typeof panel.experimental_useBadge]), [['nucleus-board', 'board', 'function']]);
  assert.deepEqual(collected.tabs.map(tab => [tab.id, tab.context.kind, tab.availability]), [['nucleus-project-board', 'thread', 'fixed'], ['nucleus-task', 'thread', 'fixed']]);
  assert.deepEqual(collected.settingsSections.map(section => section.id), ['nucleus-settings']);
  assert.deepEqual(collected.pendingInteractions.map(entry => entry.id), ['nucleus-question']);
  assert.deepEqual(collected.appOverlays.map(entry => entry.id), ['nucleus-runtime']);
  assert.deepEqual(collected.threadActions.map(entry => entry.id), ['nucleus-project-board']);
  assert.deepEqual(collected.composerCustomizations.map(entry => [entry.id, entry.actions?.map(action => action.id), entry.experimental_popups?.map(popup => popup.id)]), [['nucleus-pills', ['nucleus-pills'], ['nucleus-pill']]]);
  // Decision 5e: no usage surface of Nucleus's own in BB.
  assert.deepEqual([collected.sidebarFooterActions.length, collected.experimentalSidebarFooterItems.length, collected.homepageSections.length], [0, 0, 0]);
});
