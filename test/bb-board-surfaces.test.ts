/**
 * Spec 062, phase 6 acceptance: the shared board in BB, through the existing board
 * harness with the BB shell bound.
 *
 * Every catalogue call goes the production route: the BB shell's `useRpc` calls the
 * plugin's `boardCall` handler (`createBoardBridge`, the real backend code), which
 * forwards over a channel fake that records the method, the input and the `via`
 * provenance, and answers from real shapes — task summaries projected from a real
 * `Store`, decisions and question requests parsed through the shared schemas, and
 * every answer validated again by the shell against the shared contract.
 *
 * Covered here: the board renders and its calls reach the service; Settings opens
 * (the panel route, the board header's Settings button and the settings section);
 * a decision pill appears on its thread and resolves; a native question pill shows
 * and answers; the pending-interaction renderer submits and cancels; the board's
 * Usage view renders from a synthetic `usage.state` snapshot; and the per-project
 * tab shows a multi-repository project's every repository.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import React from 'react';
import { mount, useNativeStubs, type HostNode } from './support/render';
import { Store } from '../core/store/store';
import { taskWaitStateContext } from '../core/recovery/wait-context';
import { visibleTaskSummaries } from '../shared/task-view';
import { submissionSchema, uiBoardSchema, decisionViewSchema, type DecisionView, type TaskSummary } from '../shared/contracts';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import { formatAgentId } from '../shared/agent-identity';
import { usageStateOutputSchema } from '../shared/schema/usage';
import { projectUsage } from '../shared/usage-projection';
import { createBoardBridge } from '../hosts/bb/plugin/board-bridge';
import { createTaskDetailCache } from '../core/telemetry/task-detail';

useNativeStubs();

type Surfaces = typeof import('../hosts/bb/client/surfaces');
let surfaces: Surfaces;
const load = async () => { surfaces ??= await import('../hosts/bb/client/surfaces'); return surfaces; };

const h = React.createElement;
const hostId = 'bb:' + 'b'.repeat(64);
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const AT = '2026-11-17T12:00:00.000Z';

// ------------------------------------------------------------- real board shapes

const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bb-board-surfaces-'));
const store = new Store(join(directory, 'queue.sqlite'));
after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

store.upsertProject({ key: 'synthetic', name: 'Synthetic', repositories: [{ origin: null, path: '/synthetic/repo' }, { origin: null, path: '/synthetic/other' }], primary: { origin: null, path: '/synthetic/repo' } });
store.upsertProject({ key: 'elsewhere', name: 'Elsewhere', repositories: [{ origin: null, path: '/synthetic/elsewhere' }] });

function seed(title: string, repoPath: string, phase: Parameters<Store['update']>[1]['phase']) {
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath, planningCommit: 'a'.repeat(40), handoffPath: '/synthetic/handoff.md', originAgentId: 'thr_planner' }), hostId, '/synthetic/handoff.md', 'a'.repeat(40));
  store.update(task.id, { phase });
  return store.task(task.id);
}
const primaryTask = seed('Primary repository task', '/synthetic/repo', 'working');
const otherTask = seed('Second repository task', '/synthetic/other', 'awaiting_review');
const foreignTask = seed('Elsewhere project task', '/synthetic/elsewhere', 'working');
// The worker's task waits on the second repository's task, so its detail names a prerequisite.
store.update(primaryTask.id, { dependsOn: [otherTask.id] });
/** `queue.detail` exactly as the service projects it from the store. */
const taskDetail = createTaskDetailCache(store);

function summaries(overrides: Partial<Record<string, Partial<TaskSummary>>> = {}): TaskSummary[] {
  const tasks = [primaryTask, otherTask, foreignTask].map(task => store.task(task.id));
  const waits = new Map(tasks.map(task => [task.id, taskWaitStateContext(store, task, null)]));
  return visibleTaskSummaries(tasks, store.projects(), [], new Map(), waits).map(summary => ({ ...summary, ...overrides[summary.id] }));
}

function board(tasks: TaskSummary[], revision = 1) {
  return uiBoardSchema.parse({
    revision, connected: true, hostId, paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0,
    globalLimit: 32, projectLimit: 5, tasks, profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
    projects: store.projects(), prStates: {},
  });
}

const decisionFixture = (over: Partial<DecisionView> = {}): DecisionView => decisionViewSchema.parse({
  id: 'decision-1', version: 1, question: 'Which branch do we cut?', headline: 'Which branch do we cut?',
  choices: [{ label: 'main', consequence: 'Use the stable branch.' }, { label: 'branch', consequence: 'Start from the feature branch.' }],
  recommended: 'main', details: null, overtakenBy: [], context: null, options: ['main', 'branch'], recommendation: 'main',
  askedBy: { agentId: 'thr_planner', project: { origin: 'owner/synthetic', path: '/synthetic/repo' } }, links: { tasks: [], leads: [], papercuts: [] },
  askerLabel: 'planner', status: 'open', answer: null, withdrawal: null, supersededBy: null, delivery: null,
  createdAt: AT, updatedAt: AT, versions: [], stale: false, projectKey: 'synthetic', ...over,
});

const usageState = () => {
  const window = { windowId: 'weekly', name: 'Weekly', usedFraction: 0.62, windowSeconds: 7 * 24 * 3600, windowStartsAt: null, resetsAt: '2026-11-21T12:00:00.000Z' };
  return usageStateOutputSchema.parse({
    generatedAt: AT,
    subscriptions: [{ group: 'codex-main', provider: 'codex', profileIds: ['worker'], sourcePath: null,
      reading: { status: 'ok', reason: null, asOf: AT, source: 'app-server', accountId: 'acc-1', windows: [window] },
      projection: projectUsage({ now: NOW, windows: [window] }), nextReadAt: null, lastAttemptAt: AT, lastError: null }],
  });
};

// ------------------------------------------------------------- the service fake

type Call = { method: string; input: unknown; via: string | undefined };

/** The smallest answer the catalogue's own output schema accepts, for reads a test does not script. */
function emptyAnswer(method: string): unknown {
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === method);
  if (!entry) throw new Error(`${method} is not a catalogue method`);
  for (const candidate of [[], {}, null, { items: [] }, { runs: [], accounting: [] }]) {
    if ((entry.contract.output as { safeParse(value: unknown): { success: boolean } }).safeParse(candidate).success) return candidate;
  }
  throw new Error(`${method} has no empty answer in this test`);
}

function service(script: { tasks?: () => TaskSummary[]; decisions?: () => DecisionView[]; questions?: () => Array<{ requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }>; onAnswer?: (method: string, input: unknown) => void } = {}) {
  const calls: Call[] = [];
  let revision = 1;
  const sidebar = {
    groups: [],
    threads: [{ threadId: 'thr_worker', taskId: primaryTask.id, role: 'worker', environmentId: 'env_primary' }],
    projects: [
      { key: 'synthetic', name: 'Synthetic', repositoryPaths: ['/synthetic/repo', '/synthetic/other'], threadIds: ['thr_planner', 'thr_lead'], bbProjectIds: ['proj_synthetic'] },
      { key: 'elsewhere', name: 'Elsewhere', repositoryPaths: ['/synthetic/elsewhere'], threadIds: [], bbProjectIds: [] },
    ],
  };
  const channel = {
    async request(method: string, input: unknown, _timeout?: number, via?: string) {
      calls.push({ method, input, via });
      switch (method) {
        case 'queue.ui-snapshot': return board(script.tasks?.() ?? summaries(), revision++);
        case 'bb.sidebar-groups': return sidebar;
        case 'decision.list': return script.decisions?.() ?? [];
        case 'decision.agent-projects': return (input as { agents: Array<{ agentId: string }> }).agents.map(agent => ({ agentId: agent.agentId, project: agent.agentId === 'thr_planner' ? { key: 'synthetic', name: 'Synthetic' } : null }));
        case 'decision.answer': script.onAnswer?.(method, input); return decisionFixture({ status: 'answered', answer: { text: (input as { answer: string }).answer, answeredBy: 'operator (board)', answeredAt: AT, relayed: null, note: '' } });
        case 'question.native-list': return script.questions?.() ?? [];
        case 'question.native-answer': script.onAnswer?.(method, input); return { ok: true };
        case 'usage.state': return usageState();
        case 'queue.detail': return taskDetail((input as { taskId: string }).taskId);
        default: return emptyAnswer(method);
      }
    },
  };
  const bridge = createBoardBridge(() => channel);
  return { calls, bridge };
}

function fakeSdk(bridge: ReturnType<typeof createBoardBridge>, threadId = 'thr_planner') {
  const navigations: Array<{ path: string; options?: { subPath?: string } }> = [];
  const popups: string[] = [];
  const rpc = { call: async (method: string, input: { method: string; input: unknown }) => { assert.equal(method, 'boardCall'); return await bridge.boardCall(input); } };
  const navigate = { toPluginPanel: (path: string, options?: { subPath?: string }) => { navigations.push({ path, options }); }, toThread() {} };
  const composer = { scope: { kind: 'thread' as const, threadId }, experimental_openPopup: (id: string) => { popups.push(id); return true; }, experimental_closePopup: () => { popups.push('closed'); return true; } };
  const sdk = {
    useRpc: () => rpc,
    useRealtime: () => {},
    useBbNavigate: () => navigate,
    useComposer: () => composer,
    experimental_Icon: (props: { name: string }) => h('svg', { 'data-icon': props.name }),
  };
  return { sdk, navigations, popups };
}

async function settle(probe: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`${what} did not settle`);
}

/** A DOM button the composer customization draws, by its accessible name. */
const domButton = (tree: ReturnType<typeof mount>, name: string): HostNode | undefined =>
  tree.ofType('button').find(node => node.props['aria-label'] === name);

function runtimeFor(threadId = 'thr_planner', script: Parameters<typeof service>[0] = {}) {
  const fake = service(script);
  const sdk = fakeSdk(fake.bridge, threadId);
  const registered: Record<string, unknown> = {};
  const app = {
    slots: {
      navPanel: (registration: { id: string }) => { registered[`nav:${registration.id}`] = registration; },
      experimental_tab: (registration: { id: string }) => { registered[`tab:${registration.id}`] = registration; },
      settingsSection: (registration: { id: string }) => { registered[`settings:${registration.id}`] = registration; },
      pendingInteraction: (registration: { id: string }) => { registered[`interaction:${registration.id}`] = registration; },
      experimental_appOverlay: (registration: { id: string }) => { registered[`overlay:${registration.id}`] = registration; },
      experimental_threadAction: (registration: { id: string }) => { registered[`action:${registration.id}`] = registration; },
    },
    composer: { customize: (registration: { id: string }) => { registered[`composer:${registration.id}`] = registration; } },
  };
  surfaces.registerNucleusBoard(app as never, sdk.sdk as never);
  const runtime = surfaces.createBoardRuntime(sdk.sdk as never, { refreshMs: 20 });
  return { ...fake, ...sdk, registered, runtime };
}

test('the board renders in its rail panel and every call reaches the service as a forwarded BB board call', async () => {
  await load();
  const { runtime, calls, registered } = runtimeFor();
  assert.ok(registered['nav:nucleus-board'], 'the board registers as a rail nav panel');
  assert.equal((registered['nav:nucleus-board'] as { path: string }).path, 'board');
  const tree = mount(h(runtime.BoardPanel, { subPath: '' }));
  await settle(() => tree.text().includes('Primary repository task'), 'the global board');
  // The global board shows every project's work.
  assert.ok(tree.text().includes('Elsewhere project task'));
  assert.ok(calls.some(call => call.method === 'queue.ui-snapshot'), 'the board read reached the service');
  assert.ok(calls.length > 0 && calls.every(call => call.via === 'bb'), 'every forwarded call carries the BB surface');
});

test('Settings opens from the panel route, from the board header and as a settings section', async () => {
  await load();
  const { runtime, navigations, registered } = runtimeFor();
  const settings = mount(h(runtime.BoardPanel, { subPath: 'settings' }));
  await settle(() => settings.query('Nucleus settings') !== undefined, 'the Settings route');
  const board = mount(h(runtime.BoardPanel, { subPath: '' }));
  await settle(() => board.query('Settings') !== undefined, 'the board header');
  board.press('Settings');
  assert.deepEqual(navigations.at(-1), { path: 'board', options: { subPath: 'settings' } }, "the header's Settings button opens the board's Settings route");
  assert.ok(registered['settings:nucleus-settings'], 'Settings register as a settings section');
  const section = mount(h(runtime.SettingsSection));
  await settle(() => section.query('Nucleus settings') !== undefined, 'the settings section');
});

test('a decision pill appears on the asking thread, opens its popover and resolves', async () => {
  await load();
  let open = [decisionFixture()];
  const answers: unknown[] = [];
  const { runtime, popups, calls } = runtimeFor('thr_planner', { decisions: () => open, onAnswer: (method, input) => { if (method === 'decision.answer') { answers.push(input); open = []; } } });
  const overlay = mount(h(runtime.Runtime));
  const composer = mount(h(runtime.ComposerPills));
  await settle(() => domButton(composer, '1 here · 1 all') !== undefined, 'the decision pill');
  domButton(composer, '1 here · 1 all')!.props.onClick();
  assert.deepEqual(popups, ['nucleus-pill'], "the pill opens the plugin's composer popup");
  const popup = mount(h(runtime.PillPopup));
  await settle(() => popup.text().includes('Which branch do we cut?'), 'the decision popover');
  popup.type('Answer box: Which branch do we cut?', 'main');
  popup.press('Answer decision: Which branch do we cut?');
  await settle(() => answers.length === 1, 'the decision answer');
  assert.equal((answers[0] as { answer: string }).answer, 'main');
  assert.ok(calls.filter(call => call.method === 'decision.answer').every(call => call.via === 'bb'));
  await settle(() => domButton(composer, '1 here · 1 all') === undefined, 'the resolved pill to clear');
  overlay.update(h(() => null));
});

test('a native question pill shows on the asking role thread and answers through the service', async () => {
  await load();
  let pending = [{ requestId: 'req-1', questions: [{ header: 'Branch', question: 'Which branch should I use?', options: ['main', 'feature'] }] }];
  const answers: unknown[] = [];
  const tasks = () => summaries({ [primaryTask.id]: { questionAgentIds: pending.length ? ['thr_worker'] : [] } });
  const { runtime, popups } = runtimeFor('thr_worker', { tasks, questions: () => pending, onAnswer: (method, input) => { if (method === 'question.native-answer') { answers.push(input); pending = []; } } });
  const overlay = mount(h(runtime.Runtime));
  const composer = mount(h(runtime.ComposerPills));
  await settle(() => domButton(composer, '1 question') !== undefined, 'the question pill');
  domButton(composer, '1 question')!.props.onClick();
  assert.deepEqual(popups, ['nucleus-pill']);
  const popup = mount(h(runtime.PillPopup));
  await settle(() => popup.text().includes('Which branch should I use?'), 'the question popover');
  popup.press('Answer Which branch should I use?: main');
  popup.press('Submit answers');
  await settle(() => answers.length === 1, 'the question answer');
  assert.deepEqual(answers[0], { taskId: primaryTask.id, agentRef: formatAgentId(hostId, 'thr_worker'), requestId: 'req-1', answers: { Branch: 'main' } });
  await settle(() => domButton(composer, '1 question') === undefined, 'the answered pill to clear');
  overlay.update(h(() => null));
});

test('the pending-interaction slot renders a Nucleus question, submits and cancels', async () => {
  await load();
  const submitted: unknown[] = [];
  let cancelled = 0;
  const props = {
    interaction: { id: 'int-1', threadId: 'thr_worker', title: 'Nucleus needs an answer', payload: { question: 'Ship it now?', options: ['yes', 'no'], allowText: false } },
    submit: async (value: unknown) => { submitted.push(value); },
    cancel: async () => { cancelled++; },
  };
  const tree = mount(h(surfaces.NucleusQuestionInteraction, props));
  assert.ok(tree.text().includes('Ship it now?'));
  assert.equal(tree.get('Submit answer').props.disabled, true, 'nothing is chosen yet');
  tree.press('Answer yes');
  tree.press('Submit answer');
  await settle(() => submitted.length === 1, 'the submit');
  assert.deepEqual(submitted, [{ answer: 'yes' }]);
  tree.press('Cancel question');
  await settle(() => cancelled === 1, 'the cancel');
  const malformed = mount(h(surfaces.NucleusQuestionInteraction, { ...props, interaction: { ...props.interaction, payload: { prompt: 'not ours' } } }));
  assert.ok(malformed.text().includes('This question cannot be shown.'));
  malformed.press('Cancel question');
  await settle(() => cancelled === 2, 'the malformed question cancel');
});

test("the board's Usage view renders from a synthetic usage.state snapshot", async () => {
  await load();
  const { runtime, calls } = runtimeFor();
  const tree = mount(h(runtime.BoardPanel, { subPath: '' }));
  await settle(() => tree.query('Usage') !== undefined, 'the board navigation');
  tree.press('Usage');
  await settle(() => tree.text().includes('62% used'), 'the usage page');
  assert.ok(calls.some(call => call.method === 'usage.state' && call.via === 'bb'), 'the page reads usage.state through the plugin');
});

test('the per-project tab and route show a multi-repository project with every repository and nothing else', async () => {
  await load();
  const { runtime } = runtimeFor();
  const tab = mount(h(runtime.ProjectBoardTab, { threadId: 'thr_lead' }));
  await settle(() => tab.text().includes('Primary repository task'), 'the project tab board');
  assert.ok(tab.text().includes('Second repository task'), "the project's second repository is on its board");
  assert.ok(!tab.text().includes('Elsewhere project task'), "another project's work is not");
  const route = mount(h(runtime.BoardPanel, { subPath: 'project/synthetic' }));
  await settle(() => route.text().includes('Second repository task'), 'the project route');
  assert.ok(!route.text().includes('Elsewhere project task'));
  const unknown = mount(h(runtime.BoardPanel, { subPath: 'project/nope' }));
  await settle(() => unknown.text().includes('No Nucleus project is named nope.'), 'an unknown project key');
});

test('the task tab shows the board task detail for a role thread', async () => {
  await load();
  const { runtime } = runtimeFor();
  const tab = mount(h(runtime.TaskTab, { threadId: 'thr_worker' }));
  await settle(() => tab.text().includes('Primary repository task') && tab.query('Runs & agents') !== undefined, 'the task detail');
  // A prerequisite link opens that task in the tab, as on the board, and Back returns.
  tab.press('Runs & agents');
  await settle(() => tab.all(/^Second repository task · /u).length === 1, 'the prerequisite link');
  tab.all(/^Second repository task · /u)[0]!.props.onPress();
  await settle(() => tab.query("Back to this thread's task") !== undefined && !tab.text().includes('Primary repository task'), 'the prerequisite detail');
  tab.press("Back to this thread's task");
  await settle(() => tab.text().includes('Primary repository task') && tab.query("Back to this thread's task") === undefined, 'the return to the thread task');
  const other = mount(h(runtime.TaskTab, { threadId: 'thr_planner' }));
  await settle(() => other.text().includes("This thread is not a Nucleus task's thread."), 'a non-role thread');
});
