import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// The host wraps contributed components with these providers from the SDK's host
// entry. A static import keeps them in the same module cache the client bundle's
// own SDK imports resolve to (one React context instance).
import { PluginClientStateProvider, PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { boardShellPlugin, mount, useNativeStubs, type HostNode } from './support/render';
import { pipelineColumns, pipelineStubWidth } from '../shared/pipeline-board';
import {Store} from '../core/store/store';
import {hostRunRecordSchema, submissionSchema, summarizeTask, type ProjectQaRun} from '../shared/contracts';
import {CAPACITY_WAIT_PREFIX} from '../shared/wait-state';
import {createTaskDetailCache} from '../core/telemetry/task-detail';
import {leadFromPapercut} from '../shared/papercut-lead';
import type {Papercut} from '../shared/contracts';

useNativeStubs();

const h = React.createElement;
/** Dark-theme palette standing in for the operator's Paseo theme. Every themed
 * style in the board must resolve to one of these (or a fixed overlay literal). */
const dark = {
  accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22',
  surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e',
  statusWarning: '#f0883e', statusDanger: '#f85149',
} as const;
const fixedLiterals = new Set(['#000', 'rgba(0, 0, 0, 0.68)', 'rgba(0,0,0,0.68)', 'transparent']);
const c = dark as never;

const repo = { origin: 'owner/app', path: '/app' };
const project = { key: 'app', name: 'App', version: 1, visibility: 'active', repositories: [repo], primary: repo };
const projectDRepo = { origin: 'owner/project-d', path: '/project-d' };
const projectDProject = { key: 'project-d', name: 'Project-D', version: 1, visibility: 'active', repositories: [projectDRepo], primary: projectDRepo };
const laneView = (key: string) => ({
  id: key, key, title: key === 'first' ? 'First' : 'Second', aim: `Aim ${key}`, status: 'active',
  note: '', repositories: [repo], createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  closedAt: null, liveByPhase: {}, liveByRepository: {}, terminalCount: 0, lastActivityAt: null, recentOutcomes: [],
});
const lanes = [laneView('first'), laneView('second')];
const plan = {
  project: 'app', version: 1,
  entries: [{ lane: 'second', note: '', horizon: 'now' }, { lane: 'first', note: '', horizon: 'now' }],
  author: null, createdAt: null,
  savedEntries: [{ lane: 'second', note: '', horizon: 'now' }, { lane: 'first', note: '', horizon: 'now' }],
};
const phases = ['queued', 'dispatching', 'working', 'changes_requested', 'blocked', 'error', 'needs_attention', 'awaiting_review', 'reviewing', 'verifying', 'merging', 'syncing', 'closing'] as const;
const summary = (id: string, title: string, lanes: string[], phase: string) => ({
  id, title, repoPath: '/app', repository: 'owner/app', version: 1, number: null as number | null, reference: null as string | null,
  entrypoint: 'worker', phase, reason: `Reason ${title}`, held: false, dependsOn: [], queuePriority: 0,
  parked: ['needs_attention', 'awaiting_review', 'changes_requested', 'verifying'].includes(phase),
  profile: null, prUrl: null, resumePrNumber: null, completionPrNumber: null, originError: '',
  originLookupError: '', lanes, disposition: null, resolution: { attention: false, mergedCommit: null },
});
type VisualTaskSummary = ReturnType<typeof summary> & {
  holdKind?: 'dispatch' | 'merge';
  holdEscalated?: boolean;
  hold?: { owner: string; reason: string; since: string | null };
  waitState?: { state: 'waiting_capacity' | 'waiting_prerequisite' | 'needs_operator_input' | 'needs_source_rights' | 'merge_hold'; owner: string; nextAction: string; decisionId?: string };
};
const tasks: VisualTaskSummary[] = [
  ...phases.map(phase => summary(`task-${phase}`, `Task ${phase}`, ['first'], phase)),
  summary('shared', 'Shared task', ['first', 'second'], 'working'),
  summary('unlaned', 'Unlaned task', [], 'queued'),
];
const papercut = {
  id: 'cut-1', repository: { origin: 'owner/app', path: '/app' }, area: null as string | null, title: 'Cut one', version: 1,
  happened: 'It happened', impact: 'Impact', fix: null as string | null, filedBy: 'operator',
  filedAt: '2026-09-27T00:00:00.000Z', state: 'open' as 'open' | 'promoted' | 'closed', taskId: null as string | null, closedReason: null as 'completed' | 'deprecated' | null,
  draftId: null, note: null as string | null, closedAt: null, source: null, lanes: ['first'],
};
const taggedLead = () => leadFromPapercut(papercut as Papercut);
/** The narrow lead.board card a fixture projects to; lead.get keeps serving the full record. */
const boardRow = (row: { id: string; title: string; body: string; repositories: { origin: string; path: string }[]; lanes: string[]; tags: string[];
  papercut: { area: string | null } | null; state: string; version: number; check: { ok: boolean } | null; approval: unknown;
  targets: Array<{ kind: string; repository: string | null }> }) => ({
  id: row.id, title: row.title, preview: row.body.slice(0, 400), repositories: row.repositories, lanes: row.lanes, tags: row.tags,
  papercutArea: row.papercut?.area ?? null, state: row.state, version: row.version,
  check: row.check ? { ok: row.check.ok } : null, approved: Boolean(row.approval),
  targets: row.targets.filter(target => target.kind === 'draft' || target.kind === 'task').map(target => ({ kind: target.kind, repository: target.repository })),
});
/** The server-side card filter of lead.board (store.listBoardLeads): open leads, plus promoted
 * leads holding a draft/task target and still a repository without one. Dropped and fully
 * promoted leads never come back as cards; a mock that skips this serves records the real read
 * cannot, and a dropped row's state fails the output schema on every later poll. */
const boardCards = <T extends { state: string; repositories: Array<{ origin: string }>; targets: Array<{ kind: string; repository: string | null }> }>(rows: readonly T[]) =>
  rows.filter(row => row.state === 'open' || (
    row.targets.some(target => target.kind === 'draft' || target.kind === 'task') &&
    row.repositories.some(repo => !row.targets.some(target =>
      target.repository === repo.origin && (target.kind === 'draft' || target.kind === 'task')))));
const lead = {
  id: 'lead-1', title: 'Lead one', body: 'Lead body', repositories: [{ origin: 'owner/app', path: '/app' }],
  lanes: ['first'], author: 'operator', state: 'open' as 'open' | 'promoted' | 'dropped', version: 1,
  digest: undefined as string | undefined, check: null as { ok: boolean; message: string; checkedAt: string; planningCommit: string | null } | null,
  approval: null as { version: number; digest: string; approver: string; approvedAt: string; note: string; relayed: boolean } | null,
  baseBranch: 'main', dropReason: null as string | null, targets: [] as Array<{ kind: 'task' | 'draft' | 'question' | 'knowledge'; repository: string | null; reference: string; at: string }>, source: null,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', closedAt: null,
  tags: [] as string[], papercut: null, closure: null,
};
const board = {
  revision: 1, connected: true, hostId: 'host', paused: false, dispatchHeld: false, error: '', quiet: false,
  activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 5, projectLimitOverrides: {},
  tasks, profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
  lanes, projects: [project], prStates: {},
};
const service = { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
let hostRunsForUi: ReturnType<typeof hostRunRecordSchema.parse>[] = [];
const hostRunCapacityReleases: Array<{ runId: string; reason: string }> = [];
let projectQaRunsForUi: ProjectQaRun[] = [];
const projectQaRunRequests: string[] = [];
const projectQaActions: Array<{ method: string; input: { id: string; reason: string } }> = [];

/** Methods the surface asked for, so one read replacing two is provable. */
const rpcMethods: string[] = [];
const invoke = async (method: string, input: unknown): Promise<unknown> => {
  rpcMethods.push(method);
  if (method === 'queue.ui-snapshot') return board;
  if (method === 'queue.service-state') return service;
  if (method === 'papercut.list') return [papercut];
  if (method === 'papercut.get') return papercut;
  if (method === 'decision.list') return [];
  if (method === 'host.run.list') return hostRunsForUi;
  if (method === 'host.run.accounting.list') return { readAt: '2026-09-27T00:00:00.000Z', entries: [], complete: true };
  // Audit A8: the board polls one combined read; both halves are this mock's.
  if (method === 'host.run.board') return { runs: hostRunsForUi, accounting: { readAt: '2026-09-27T00:00:00.000Z', entries: [], complete: true } };
  if (method === 'project.qa.list') return projectQaRunsForUi;
  if (method === 'project.qa.run') {
    projectQaRunRequests.push((input as { repository: string }).repository);
    return projectQaRunsForUi[0] ?? {};
  }
  if (method === 'project.qa.cancel' || method === 'project.qa.retry-teardown') {
    projectQaActions.push({ method, input: input as { id: string; reason: string } });
    return projectQaRunsForUi.find(run => run.id === (input as { id: string }).id) ?? {};
  }
  if (method === 'host.run.capacity.release') {
    hostRunCapacityReleases.push(input as { runId: string; reason: string });
    return hostRunsForUi[0];
  }
  if (method === 'lead.board') return { cards: boardCards([lead, taggedLead()]).map(boardRow), links: [] };
    if (method === 'lead.get') return {
      ...lead,
      versions: [{ version: 1, title: lead.title, body: lead.body, author: lead.author, createdAt: lead.createdAt, check: lead.check }],
    };
  if (method === 'plans') return [plan];
  if (method === 'plan.get') return plan;
  return {};
};

const tick = () => new Promise(resolve => setImmediate(resolve));

function hostRunFixture(id: string, overrides: Record<string, unknown> = {}) {
  const submittedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  return hostRunRecordSchema.parse({
    id, epoch: 2, caller: 'client:Effigy interactive', submissionSource: 'client', repository: repo, selector: 'test',
    runClass: 'light', classSource: 'default', priority: 'interactive', state: 'settled', submittedAt,
    capacityDeadlineAt: new Date(Date.now() + 3 * 60_000).toISOString(), runTimeoutMs: 30 * 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000_000_000 },
    budget: { cpu: 1, memoryBytes: 1_000_000_000, wallMs: null, source: 'fallback' },
    position: null, admittedAt: submittedAt, launchedAt: submittedAt, settledAt: null, capacitySample: null,
    pid: 4242, processGroupId: 4242, startIdentity: '4242@identity', settlement: null,
    wallMs: null, cpuMs: null, containers: [], capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
    ...overrides,
  });
}

function settledRun(id: string, caller: string, repository: { origin: string | null; path: string }, outcome: 'passed' | 'failed' | 'cancelled', settledAt: string, selector = 'qa', holdCapacity = false) {
  const submittedAt = new Date(Date.parse(settledAt) - 4 * 60_000).toISOString();
  const startedAt = new Date(Date.parse(settledAt) - 2 * 60_000).toISOString();
  return hostRunFixture(id, {
    caller, repository, selector, priority: caller.startsWith('queue:milestone:') ? 'milestone' : 'interactive',
    state: 'settled', submittedAt, launchedAt: startedAt, admittedAt: startedAt, settledAt,
    wallMs: 120_000, capacityReleasedAt: holdCapacity ? null : settledAt,
    containers: holdCapacity ? [{ runtime: 'docker', containerId: `held-${id}`, removed: false, startedAt, removedAt: null }] : [],
    settlement: {
      format: 'host.run.settlement', version: 1, runId: id, outcome, launched: true, settledAt,
      containers: [], result: {
        format: 'host.run.result', version: 1, runId: id, epoch: 2, pgid: 4242, startIdentity: '4242@identity',
        exitCode: outcome === 'passed' ? 0 : 1, signal: null, startedAt, endedAt: settledAt, wallMs: 120_000, cpuMs: null, escapedDescendants: [],
      },
    },
  });
}

function projectQaFixture(id: string, overrides: Partial<ProjectQaRun> = {}): ProjectQaRun {
  return {
    id, repository: repo, key: repo.origin!, state: 'failed', submittedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    queuePosition: null, hostRunEpoch: 2, selector: 'qa:changed', runClass: 'heavy', classSource: 'default', priority: 'milestone',
    baseBranch: 'main', base: 'b'.repeat(40), argv: ['effigy', 'qa:changed'], digest: 'd'.repeat(64), exitCode: 1, durationMs: 120_000,
    outputTail: 'The check failed\nExpected one run to pass', startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    finishedAt: new Date().toISOString(), pid: 4242, capacityWait: null, capacityUnavailable: false,
    steps: [{ name: 'teardown', command: 'paseo worktree.teardown', exitCode: 1, signal: null, timedOut: false,
      stdoutHead: '', stdoutTail: '', stderrHead: '', stderrTail: 'Worktree cleanup needs a retry', } as never],
    failedStep: 'teardown', logWriteErrors: [], interruptedStep: null, hostSettlement: null, escapedDescendants: [], cancelReason: null,
    ...overrides,
  } as ProjectQaRun;
}

/**
 * The host loads the plugin as a CJS bundle. Like plugin-load.test.ts guards the
 * server entry, this builds the client entry the way the host does and renders
 * MainSurface from the bundle — so the dark-theme check at both viewport sizes
 * verifies the artifact the installed bundle carries, not just the sources.
 * React, the JSX runtime, react-query and the plugin client stay single-instance
 * with the test's own imports; only react-native resolves to the host stubs.
 */
let bundledMainSurface: ((props: unknown) => React.ReactNode) | null = null;
async function bundleMainSurface() {
  if (bundledMainSurface) return bundledMainSurface;
  const root = resolve(import.meta.dirname, '..');
  // Resolve external singletons from this test, without writing a bundle into the checkout.
  const result = await build({
    entryPoints: [join(root, 'client/queue.tsx')],
    bundle: true, plugins: [boardShellPlugin],
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    logLevel: 'silent',
    external: [
      'react',
      'react/jsx-runtime',
      '@tanstack/react-query',
      '@getpaseo/plugin/client',
      '@getpaseo/plugin/client/host',
    ],
    alias: {
      'react-native': join(root, 'test/support/native-stub.mjs'),
      '@getpaseo/plugin/client/react-native': join(root, 'test/support/native-stub.mjs'),
    },
  });
  const compiled = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), compiled, compiled.exports);
  assert.equal(typeof compiled.exports.MainSurface, 'function', 'the client bundle must export MainSurface');
  bundledMainSurface = compiled.exports.MainSurface as (props: unknown) => React.ReactNode;
  return bundledMainSurface;
}

test('the bundled board status keeps the project default and override count readable', async () => {
  const mainSurface = await bundleMainSurface();
  const previous = board.projectLimitOverrides;
  board.projectLimitOverrides = { 'project-a': 6 };
  const ui = mount(tree(mainSurface, false));
  try {
    await settleUntil(ui, () => ui.text().includes('project default 5 · 1 override'), 'the bundled board status did not include the project override count');
    assert.match(ui.text(), /project default 5 · 1 override/);
  } finally {
    unmount(ui);
    board.projectLimitOverrides = previous;
  }
});

function hostStyle(node: HostNode): Record<string, unknown> {
  const style = node.props.style;
  return style && typeof style === 'object' && !Array.isArray(style) ? style as Record<string, unknown> : {};
}

function ancestorsOf(root: HostNode, target: HostNode): HostNode[] {
  const chain: HostNode[] = [];
  const walk = (node: HostNode): boolean => {
    if (node === target) return true;
    for (const child of node.children) {
      if (typeof child !== 'string' && walk(child)) {
        chain.push(node);
        return true;
      }
    }
    return false;
  };
  walk(root);
  return chain;
}

function assertHeaderMenuStacksAboveNav(ui: ReturnType<typeof mount>, menuLabel: string, overlayLabel: string) {
  const menu = ui.get(menuLabel);
  const overlayZ = Number(hostStyle(ui.get(overlayLabel)).zIndex ?? 0);
  const root = ui.ofType('View')[0];
  const headerRow = ancestorsOf(root, menu).find(node => hostStyle(node).justifyContent === 'space-between');
  assert.ok(headerRow, 'the menu lives under the title+controls header row');
  const headerZ = Number(hostStyle(headerRow!).zIndex ?? 0);
  const navRow = ui.ofType('View').find(node => {
    const style = hostStyle(node);
    return style.zIndex === 20 && style.justifyContent === 'space-between';
  });
  assert.ok(navRow, 'the nav row still stacks at zIndex 20 so its own dropdowns overlay the board');
  assert.ok(overlayZ > 20, 'the outside-press layer covers the nav row and the board');
  assert.ok(headerZ > 20, 'the header row itself stacks above the nav row; a nested wrapper zIndex 50 is not enough');
  assert.ok(headerZ > overlayZ, 'raising the header row keeps the menu above the outside-press layer');
}

for (const compact of [false, true]) test(`706: bundled dark icon-and-chevron pause control acts on one press (${compact ? 'compact' : 'wide'})`, async () => {
  const MainSurface = await bundleMainSurface();
  const calls: Array<{ method: string; input: any }> = [];
  const rpc: typeof invoke = async (method, input) => {
    if (method === 'queue.ui-snapshot') return structuredClone(board);
    if (method === 'queue.control') {
      calls.push({ method, input });
      Object.assign(board, input);
      board.revision++;
      return { ok: true };
    }
    if (method === 'queue.stop-threads') {
      calls.push({ method, input });
      assert.equal(board.paused, true, 'stop runs after pause');
      return { ok: true, stopped: 0 };
    }
    return invoke(method, input);
  };
  const ui = mount(tree(MainSurface, compact, rpc));
  try {
    await settleUntil(ui, () => ui.query('Queue controls menu')?.props.disabled === false, 'split button not ready');
    assert.equal(ui.get('Queue controls menu').props.accessibilityState.expanded, false);
    assert.equal(ui.query('Pause'), undefined, 'the main control is icon-only; Pause is a menu row');
    ui.press('Pause and drain');
    await settleUntil(ui, () => !!ui.query('Resume orchestration'), `pause did not become Resume: ${JSON.stringify(calls)} ${ui.text().slice(0, 450)}`);
    ui.press('Resume orchestration');
    await settleUntil(ui, () => !board.paused && !!ui.query('Pause and drain'), 'resume did not release pause');
    ui.press('Queue controls menu');
    assert.equal(ui.get('Queue controls menu').props.accessibilityState.expanded, true);
    assert.equal(ui.get('Pause').props.accessibilityRole, 'menuitem');
    assert.equal(ui.get('Dispatch hold').props.accessibilityRole, 'menuitem');
    assert.equal(ui.get('Stop').props.accessibilityRole, 'menuitem');
    assertHeaderMenuStacksAboveNav(ui, 'Queue controls', 'Close queue controls');
    ui.press('Dispatch hold');
    await settleUntil(ui, () => ui.query('Queue controls') === undefined && ui.text().includes('Dispatch held'), 'hold has no one-click release');
    assert.equal(ui.query('Confirm stop'), undefined);
    ui.press('Queue controls menu');
    const releaseItem = ui.all('Release dispatch hold').find(node => node.props.accessibilityRole === 'menuitem');
    assert.ok(releaseItem, 'the menu offers Release dispatch hold as a row');
    releaseItem!.props.onPress();
    await settleUntil(ui, () => ui.query('Queue controls') === undefined && !ui.text().includes('Dispatch held'), 'release did not clear hold');
    ui.press('Queue controls menu');
    ui.press('Stop');
    await settleUntil(ui, () => calls.some(call => call.method === 'queue.stop-threads'), 'stop not submitted');
    assert.equal(ui.query('Confirm stop'), undefined, 'Stop has no arm or confirm step');
    assert.equal(ui.query('Queue controls'), undefined, 'selecting a row closes the menu');
    assert.deepEqual(calls.slice(-2).map(call => [call.method, call.input]), [
      ['queue.control', { paused: true }], ['queue.stop-threads', { caller: 'operator (board)' }],
    ]);
  } finally {
    unmount(ui);
    board.paused = false;
    board.dispatchHeld = false;
    board.revision++;
  }
});

function tree(MainSurface: (props: unknown) => React.ReactNode, compact: boolean, rpc: typeof invoke = invoke, failFast = false) {
  return h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: failFast ? false : 3 } } }),
    children: h(PluginRpcProvider, {
      invoke: rpc,
      children: h(MainSurface as never, {
        theme: { colors: c }, layout: { compact, platform: 'ios' as const },
        navigation: {},
      }),
    }),
  });
}

/** Yield until the pipeline header and its cards render, or fail. */
async function settle(ui: ReturnType<typeof mount>) {
  const rendered = () => {
    const joined = ui.ofType('Text').map(node => node.children.join(''));
    return joined.includes('Closing') && joined.includes('Task queued') && joined.includes('Cut one');
  };
  for (let attempt = 0; attempt < 400; attempt++) {
    if (rendered()) return;
    await tick();
  }
  assert.fail('the pipeline board did not render');
}

async function settleUntil(ui: ReturnType<typeof mount>, probe: () => boolean, message: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail(message);
}

function unmount(ui: ReturnType<typeof mount>) {
  ui.update(h('View', null));
}

const countText = (ui: ReturnType<typeof mount>, value: string) =>
  ui.ofType('Text').filter(node => node.children.join('') === value).length;
const navigationButtons = (ui: ReturnType<typeof mount>) => ui.get('Nucleus navigation').children
  .filter((node): node is HostNode => typeof node !== 'string' && node.type === 'Pressable');
const navigationLabels = (ui: ReturnType<typeof mount>) => navigationButtons(ui).map(node => String(node.props.accessibilityLabel));
const navigationButton = (ui: ReturnType<typeof mount>, name: string) => {
  const button = navigationButtons(ui).find(node => String(node.props.accessibilityLabel).replace(/\s+\(\d+(?: open)?\)$/, '') === name);
  assert.ok(button, `missing ${name} navigation tab`);
  return button;
};
/** Column headers carry the full column width, labelled "Name, count". */
const headers = (ui: ReturnType<typeof mount>, width: number) =>
  ui.ofType('View').filter(node => (node.props.style as { width?: number } | undefined)?.width === width && /^[A-Za-z]+, \d+$/.test(String(node.props.accessibilityLabel ?? '')))
    .map(node => String(node.props.accessibilityLabel).split(',')[0]);

/** Every themed color resolves to the dark palette (or a fixed overlay literal). */
function assertDarkTheme(ui: ReturnType<typeof mount>) {
  const palette: Set<string> = new Set(Object.values(dark));
  const visit = (node: HostNode) => {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    for (const style of styles) {
      if (!style || typeof style !== 'object') continue;
      for (const key of ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor', 'placeholderTextColor', 'shadowColor'] as const) {
        const value = (style as Record<string, unknown>)[key];
        if (value === undefined || value === null) continue;
        assert.equal(typeof value, 'string', `${key} must be a color string`);
        assert.ok(palette.has(value as string) || fixedLiterals.has(value as string), `${key} ${value} is outside the dark palette`);
      }
    }
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  for (const node of ui.ofType('View')) visit(node);
  for (const node of ui.ofType('Text')) visit(node);
}

async function verifyViewport(compact: boolean) {
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, compact));
  try {
    await settle(ui);
    assert.deepEqual(navigationLabels(ui).map(label => label.replace(/\s+\(\d+(?: open)?\)$/, '')), ['Tasks', 'Planning', 'QA runs']);
    assert.equal(ui.query(/^Decisions \(/), undefined, 'Decisions has no top-level tab');
    assert.equal(ui.query('Papercuts'), undefined, 'Papercuts has no top-level tab');
    assert.equal(ui.query('Board mode'), undefined, 'Tasks has no Pipeline/Lanes mode toggle');
    // #866: the Lanes destination is folded into Planning; the board's Lanes switch went on 2026-11-08.
    assert.equal(ui.all('Lanes').length, 0, 'nothing is labelled Lanes on Tasks');
    navigationButton(ui, 'Planning').props.onPress();
    assert.ok(ui.get('Find lanes'), 'Planning carries lane discovery now');
    assert.ok(ui.get(/^Project: /), 'and its own project chooser');
    assert.ok(ui.query(/^Projects, /), 'the header project selector stays available on Planning');
    navigationButton(ui, 'Tasks').props.onPress();
    assert.equal(ui.query('Find lanes'), undefined);
    assert.equal(countText(ui, 'Parked (no slot held)'), 4, 'parked lifecycle tasks carry the no-slot badge');
    const width = compact ? 260 : 300;
    // Seven columns in spec order, each card kind present, no retired board. This fixture has no
    // decisions, so the Decisions column is an empty stub (nucleus-ui finding 1), not a full-width column.
    assert.deepEqual(headers(ui, width), pipelineColumns.filter(name => name !== 'Decisions'));
    assert.ok(ui.query('Decisions, 0, empty'), 'the empty Decisions column keeps its name and real total in a stub');
    assert.ok(ui.get('Nucleus navigation'));
    assert.equal(ui.query(/^Decisions \(/), undefined, 'the Decisions column count replaces the removed tab count');
    assert.equal(ui.query('Filter by project'), undefined, 'no separate filter switch on the board');
    assert.equal(ui.query(/^Status$/), undefined, 'no retired board toggle');
    for (const phase of phases) assert.equal(countText(ui, `Task ${phase}`), 1, `${phase} renders once`);
    assert.equal(countText(ui, 'Shared task'), 1, 'a card in two lanes renders once');
    assert.equal(countText(ui, 'Cut one'), 1);
    assert.equal(countText(ui, 'Lead one'), 1);
    ui.press('Filter Triage by tag, All tags (2)');
    ui.press('Filter Triage by tag: Papercut (1)');
    assert.equal(countText(ui, 'Cut one'), 1);
    assert.equal(countText(ui, 'Lead one'), 0);
    ui.press('Filter Triage by tag, Papercut (1)');
    ui.press('Filter Triage by tag: All tags (2)');
    assert.equal(countText(ui, 'Lead one'), 1);
    // Tom, 2026-11-08: the swim-lane view is retired. No switch, no lane rows, no row toggles.
    assert.equal(ui.query('Lanes'), undefined, 'no Lanes switch beside the project selector');
    assert.equal(ui.ofType('Pressable').filter(node => node.props.accessibilityRole === 'switch').length, 0, 'the board header holds no switch');
    assert.equal(ui.query(/lane, \d+ cards/), undefined, 'no swim-lane row headers');
    assert.equal(ui.query(/^Show \d+ more in .*, (Decisions|Attention|Queued|Working|Review|Closing)$/), undefined, 'no per-cell "N more" control');
    assert.equal(ui.query(/^Collapse /), undefined, 'no per-cell collapse control');
    assert.equal(ui.query('Promote'), undefined, 'pipeline cards render no Promote button');
    assert.equal(ui.query('Approve'), undefined, 'pipeline cards render no Approve button');
    assert.equal(ui.query('Drop'), undefined, 'pipeline cards render no Drop button');
    assert.equal(ui.query('Check again'), undefined, 'pipeline cards render no Check again button');
    assert.equal(ui.ofType('Pressable').filter(node => node.props.accessibilityRole === 'toolbar').length, 0, 'no card action toolbar');
    ui.press('Triage: Lead one');
    await settleUntil(ui, () => ui.query('Lead detail') !== undefined && ui.query('Check the brief') !== undefined, 'the lead modal did not load');
    assert.equal(ui.query('Open'), undefined, 'a lead click does not switch to the Papercuts tab');
    assert.equal(ui.get('Approve the checked version').props.accessibilityState.disabled, true);
    assert.match(ui.text(), /Lead has no brief to approve/);
    assertDarkTheme(ui);
    ui.press('Close lead detail');
    ui.press('Triage: Cut one');
    await settleUntil(ui, () => ui.query('Papercut detail') !== undefined && ui.query('Close as completed') !== undefined, 'the papercut modal did not load');
    assert.equal(ui.query('Open'), undefined, 'a papercut click does not switch to the Papercuts tab');
    assert.ok(ui.get('Promote'));
    assert.ok(ui.get('Close as completed'));
    assertDarkTheme(ui);
    ui.press('Close papercut detail');
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
  }
}

test('026-14/A2 the bundled Planning tab renders its roadmap in the dark theme', async () => {
  const MainSurface = await bundleMainSurface();
  // A project without an owner is grouped as dormant, which the Planning tab folds away.
  const previousProjects = board.projects;
  board.projects = [{ ...project, owner: { agentId: 'thread', assignedBy: 'operator', assignedAt: '2026-09-27T00:00:00.000Z', note: '' } }] as never;
  const ui = mount(tree(MainSurface, false));
  try {
    await settle(ui);
    navigationButton(ui, 'Planning').props.onPress();
    await settleUntil(ui, () => ui.text().includes('Version 1'), `the bundled Planning tab did not render its roadmap: ${ui.text().slice(0, 600)}`);
    assert.ok(ui.get('Now band'));
    assert.match(ui.text(), /Version 1/);
    assert.doesNotMatch(ui.text(), /Loading plan/, 'a saved version at the current plan version renders at once');
    assert.ok(ui.get('Open lane first'), 'the roadmap lists its lanes');
    for (const view of ui.ofType('View'))
      assert.equal(view.children.some(child => typeof child === 'string'), false, `raw text child under View ${view.props.accessibilityLabel ?? ''}`);
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
    board.projects = previousProjects;
  }
});

test('026-13/15 the bundled Pipeline renders in the dark theme at the wide viewport', async () => {
  await verifyViewport(false);
});

test('026-13/15 the bundled Pipeline renders in the dark theme at the compact viewport', async () => {
  await verifyViewport(true);
});

test('141 the bundled Pipeline distinguishes dispatch and merge holds in the dark theme', async () => {
  const originalTasks = board.tasks;
  board.tasks = [
    ...originalTasks,
    { ...summary('dispatch-held', 'Ordinary hold', [], 'queued'), held: true, holdKind: 'dispatch' },
    { ...summary('merge-held', 'Merge hold', [], 'queued'), reason: 'Waiting for prerequisites', held: true, holdKind: 'merge' },
  ];
  let ui: ReturnType<typeof mount> | undefined;
  try {
    const MainSurface = await bundleMainSurface();
    ui = mount(tree(MainSurface, false));
    await settle(ui);
    assert.equal(countText(ui, 'Dispatch held'), 1);
    assert.equal(countText(ui, 'Merge held'), 1);
    assert.ok(ui.text().includes('Waiting for prerequisites'), 'the queued merge hold keeps its prerequisite reason');
    const mergeCard = ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).startsWith('app, Merge hold, Queued, Merge held'));
    assert.ok(mergeCard, 'the merge-held queued task retains its queued state in the card label');
    assert.equal(ui.query('On hold'), undefined);
    for (const [label, color] of [['Dispatch held', dark.statusWarning], ['Merge held', dark.accent]] as const) {
      const badge: HostNode | undefined = ui.all(label).find(node => node.props.accessibilityLabel === label);
      assert.ok(badge, `${label} badge renders`);
      assert.equal((badge.props.style as { borderColor: string }).borderColor, color, `${label} uses its distinct dark-theme tone`);
    }
    assertDarkTheme(ui);
  } finally {
    if (ui) unmount(ui);
    board.tasks = originalTasks;
  }
});

test('Spec 035 bundled Pipeline shows host-run metrics and held capacity in the dark theme', async () => {
  const originalTasks = board.tasks;
  board.tasks = board.tasks.map(task => task.id === 'task-working' ? { ...task, number: 42, reference: 'owner/app#042' } : task);
  const now = Date.now();
  const submittedAt = new Date(now - 27 * 60_000).toISOString();
  const launchedAt = new Date(now - 2 * 60_000).toISOString();
  const escapedRunId = 'host-run-escaped-panel';
  const escapedSettledAt = new Date().toISOString();
  hostRunsForUi = [hostRunRecordSchema.parse({
    id: 'host-run-panel', epoch: 1, caller: `queue:validation:task-working:${'a'.repeat(40)}`, repository: repo, selector: 'qa',
    runClass: 'heavy', classSource: 'default', priority: 'validation', state: 'running', submittedAt,
    capacityDeadlineAt: new Date(now + 3 * 60_000).toISOString(), runTimeoutMs: 30 * 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000_000_000 },
    budget: { cpu: 1, memoryBytes: 1_000_000_000, wallMs: null, source: 'fallback' },
    position: null, admittedAt: launchedAt, launchedAt, settledAt: null, capacitySample: null,
    pid: 4242, processGroupId: 4242, startIdentity: '4242@identity', settlement: null,
    wallMs: 120_000, cpuMs: 60_000, containers: [{ runtime: 'docker', containerId: 'container-held', removed: 'unknown', startedAt: launchedAt, removedAt: null }],
    capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
  }), hostRunRecordSchema.parse({
    id: escapedRunId, epoch: 1, caller: 'queue:milestone:test', repository: repo, selector: 'qa:escaped',
    runClass: 'heavy', classSource: 'default', priority: 'milestone', state: 'settled', submittedAt,
    capacityDeadlineAt: new Date(now + 3 * 60_000).toISOString(), runTimeoutMs: 30 * 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000_000_000 },
    budget: { cpu: 1, memoryBytes: 1_000_000_000, wallMs: null, source: 'fallback' },
    position: null, admittedAt: launchedAt, launchedAt, settledAt: escapedSettledAt, capacitySample: null,
    pid: 4243, processGroupId: 4243, startIdentity: '4243@identity',
    settlement: { format: 'host.run.settlement', version: 1, runId: escapedRunId, outcome: 'passed', launched: true,
      settledAt: escapedSettledAt, containers: [], result: { format: 'host.run.result', version: 1, runId: escapedRunId,
        epoch: 1, pgid: 4243, startIdentity: '4243@identity', exitCode: 0, signal: null,
        startedAt: launchedAt, endedAt: escapedSettledAt, wallMs: 100, cpuMs: null,
        escapedDescendants: [{ pid: 9001, startIdentity: '9001@identity' }] } },
    wallMs: 100, cpuMs: null, containers: [], escapedDescendantsProvenDeadAt: null,
    capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
  })];
  hostRunCapacityReleases.length = 0;
  rpcMethods.length = 0;
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false));
  try {
    // Host runs share the QA list; the Pipeline stays focused on its columns.
    await settleUntil(ui, () => ui.text().includes('QA runs (2)'), 'the QA runs tab did not count the active host runs');
    // Audit A8: the board polls one combined private read, never the two it replaced.
    assert.ok(rpcMethods.includes('host.run.board'), 'the board reads the combined host-run read');
    assert.equal(rpcMethods.includes('host.run.list'), false, 'the pinned list is not polled separately');
    assert.equal(rpcMethods.includes('host.run.accounting.list'), false, 'the accounting list is not polled separately');
    assert.ok(!ui.text().includes('QA host runs'), 'the pipeline view does not render the host-run panel');
    ui.press('QA runs (2)');
    await settleUntil(ui, () => ui.text().includes('Capacity held by a container not reported removed.'), 'the bundled QA run list did not render');
    assert.ok(ui.text().includes('Now'));
    assert.ok(ui.text().includes('Results · past 24 hours'));
    assert.ok(ui.text().includes('App'));
    assert.ok(ui.text().includes('Task validation'));
    const taskValidationRow = ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).includes('Task validation'));
    assert.ok(taskValidationRow, 'task validation remains selectable from QA runs');
    taskValidationRow!.props.onPress();
    await settleUntil(ui, () => ui.query('QA run detail host-run-panel') !== undefined, 'the QA run detail did not open');
    ui.press('Diagnostics: identity, host process and output');
    assert.ok(ui.text().includes('Task · owner/app#042'), `the task identity remains reachable in run diagnostics: ${ui.text().slice(-800)}`);
    assert.ok(ui.text().includes('Commit aaaaaaaa'));
    assert.ok(ui.text().includes('Running'));
    assert.ok(!ui.text().includes('QA host runs'));
    assert.ok(ui.get('Release held capacity for run host-run-panel').props.accessibilityState.disabled);
    assert.ok(ui.text().includes('Capacity held by 1 escaped descendant not proven dead.'));
    assert.ok(ui.get('Release held capacity for run host-run-escaped-panel').props.accessibilityState.disabled);
    assertDarkTheme(ui);

    ui.type('Capacity release reason for run host-run-panel', 'Operator verified the container is stopped');
    assert.equal(ui.get('Release held capacity for run host-run-panel').props.accessibilityState.disabled, false);
    ui.press('Release held capacity for run host-run-panel');
    await settleUntil(ui, () => hostRunCapacityReleases.length === 1, 'the bundle did not submit the operator release');
    ui.type('Capacity release reason for run host-run-escaped-panel', 'Operator verified the escaped process is safe to release');
    assert.equal(ui.get('Release held capacity for run host-run-escaped-panel').props.accessibilityState.disabled, false);
    ui.press('Release held capacity for run host-run-escaped-panel');
    await settleUntil(ui, () => hostRunCapacityReleases.length === 2, 'the bundle did not submit the escaped-descendant operator release');
    assert.deepEqual(hostRunCapacityReleases, [
      { runId: 'host-run-panel', reason: 'Operator verified the container is stopped' },
      { runId: escapedRunId, reason: 'Operator verified the escaped process is safe to release' },
    ]);
    assertDarkTheme(ui);
  } finally {
    hostRunsForUi = [];
    projectQaRunsForUi = [];
    board.tasks = originalTasks;
    unmount(ui);
  }
});

test('179 bundled QA runs combine now and results, scope projects, filter failures, open details and launch from a picker', async () => {
  const originalProjects = board.projects;
  const originalTasks = board.tasks;
  const submittedAt = new Date(Date.now() - 8 * 60_000).toISOString();
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const qaFailedId = 'qa-result-failed';
  const qaQueuedId = 'qa-run-queued';
  const oldResultId = 'qa-result-old';
  const taskId = 'validation-task-17';
  const commit = 'c'.repeat(40);
  board.projects = [project, projectDProject];
  board.tasks = [...originalTasks, { ...summary(taskId, 'Validate the release path', [], 'working'), number: 17, reference: 'owner/app#017' }];
  hostRunsForUi = [
    hostRunFixture('validation-running', { caller: `queue:validation:${taskId}:${commit}`, repository: repo, selector: 'qa:changed', priority: 'validation', state: 'running', submissionSource: 'queue', submittedAt, launchedAt: startedAt, admittedAt: startedAt, settledAt: null, capacityReleasedAt: null, wallMs: null }),
    hostRunFixture(qaQueuedId, { caller: 'queue:milestone:app:queued', repository: repo, selector: 'qa', priority: 'milestone', runClass: 'heavy', state: 'queued', submittedAt, launchedAt: null, admittedAt: null, position: 2, settledAt: null, settlement: null, capacityReleasedAt: null }),
    settledRun(qaFailedId, 'queue:milestone:app:failed', repo, 'failed', new Date().toISOString()),
    settledRun('capacity-held-failed', 'client:Effigy interactive', repo, 'failed', new Date().toISOString(), 'test', true),
    settledRun('qa-result-passed', 'client:Effigy interactive', repo, 'passed', new Date(Date.now() - 5 * 60_000).toISOString(), 'interactive'),
    settledRun(oldResultId, 'client:Effigy interactive', repo, 'passed', new Date(Date.now() - 30 * 60 * 60_000).toISOString(), 'interactive'),
    settledRun('project-d-result', 'client:Effigy interactive', projectDRepo, 'passed', new Date(Date.now() - 3 * 60_000).toISOString(), 'interactive'),
  ];
  projectQaRunsForUi = [
    projectQaFixture(qaFailedId, { state: 'failed', failedStep: 'teardown', finishedAt: new Date().toISOString(),
      outputTail: 'Worktree cleanup needs a retry', failureIndexes: [{ stage: 'qa', tests: 3, failed: 1, cancelled: 1, skipped: 0,
        identities: [{ id: 2, title: 'expected mismatch', location: 'test/result.test.ts:8:2', status: 'failed' },
          { id: 3, title: 'cancelled child', location: null, status: 'cancelled' }], omittedIdentities: 0, truncated: false, diagnosticsTruncated: true }],
      steps: [{ name: 'teardown', command: 'paseo worktree.teardown', exitCode: 1, signal: null, timedOut: false,
        stdoutHead: '', stdoutTail: '', stderrHead: '', stderrTail: 'Worktree cleanup needs a retry' } as never] }),
    projectQaFixture(qaQueuedId, { state: 'queued', submittedAt, startedAt: submittedAt, finishedAt: null, exitCode: null, durationMs: 0, outputTail: '', failedStep: null, steps: [] }),
  ];
  projectQaActions.length = 0;
  projectQaRunRequests.length = 0;
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false));
  const clearProjectSelection = () => {
    let selector = ui.all(/^Projects,/)[0];
    if (!selector) return;
    if (!ui.query('Clear project selection')) ui.press(selector.props.accessibilityLabel as string);
    if (ui.query('Clear project selection')) ui.press('Clear project selection');
    selector = ui.all(/^Projects,/)[0];
    if (selector && ui.query('Clear project selection')) ui.press(selector.props.accessibilityLabel as string);
  };
  try {
    clearProjectSelection();
    await settleUntil(ui, () => ui.text().includes('QA runs (3)'), 'the QA runs navigation did not show its live run count');
    ui.press('QA runs (3)');
    await settleUntil(ui, () => ui.query('QA runs') !== undefined && ui.text().includes('Worktree cleanup needs a retry'), 'the joined QA run rows did not render');
    assert.ok(ui.query('Now'));
    assert.ok(ui.query('Results'));
    assert.ok(ui.text().includes('App'));
    assert.ok(ui.text().includes('Task validation'), 'the run category follows the primary failure and time/state');
    assert.ok(!ui.text().includes('Commit cccccccc'), 'commit identity stays in the shared run detail');
    assert.ok(!ui.text().includes('Selector · qa'), 'selector identity stays in the shared run detail');
    assert.ok(ui.ofType('View').some(node => node.props.accessibilityLabel === 'Outcome Failed'), 'failed results expose their outcome badge');
    assert.ok(ui.ofType('View').some(node => node.props.accessibilityLabel === 'Outcome Passed'), 'passed results expose their outcome badge');
    const heldFailureBadge = ui.ofType('View').find(node => node.props.accessibilityLabel === 'Outcome Failed · capacity held');
    assert.ok(heldFailureBadge, 'capacity-held failures keep the settled outcome in their badge');
    assert.ok(ui.query('QA run row capacity-held-failed'), 'capacity-held failures stay in Now');
    assert.equal((heldFailureBadge.props.style as { borderColor: string }).borderColor, dark.statusDanger, 'capacity-held failure badges keep the danger tone');
    assert.equal(ui.get('Open task #017').props.accessibilityRole, 'link');
    assert.ok(ui.text().includes('Worktree cleanup needs a retry · App'));
    assert.ok(!ui.text().includes('teardown failed · Worktree cleanup needs a retry'), 'the failed step is not repeated before its diagnostic');
    assert.ok(ui.query('QA run row project-d-result'), 'unfiltered results include the second project');
    assert.ok(!ui.query('QA run row qa-result-old'), 'results older than 24 hours start collapsed');

    ui.press('Failed only');
    assert.ok(ui.query(`QA run row ${qaFailedId}`), 'Failed only retains failed results');
    assert.equal(ui.query('QA run row qa-result-passed'), undefined, 'Failed only hides passed results');
    ui.press('Failed only');

    const pressQaRow = (id: string) => {
      const root = ui.get(`QA run row ${id}`);
      const find = (node: HostNode): HostNode | undefined => {
        if (node.props.accessibilityRole === 'button' && String(node.props.accessibilityLabel).includes('Open QA run details')) return node;
        for (const child of node.children) if (typeof child !== 'string') { const found = find(child); if (found) return found; }
        return undefined;
      };
      const button = find(root);
      assert.ok(button, `QA run row ${id} has an accessible detail action`);
      button!.props.onPress();
    };
    pressQaRow(qaFailedId);
    assert.ok(ui.query(`QA run detail ${qaFailedId}`));
    assert.ok(ui.text().includes('Steps'));
    assert.ok(ui.text().includes('teardown · exit 1'));
    assert.ok(ui.text().includes('Settlement'));
    assert.equal(ui.query('QA run identity'), undefined, 'identity is behind the diagnostics disclosure');
    ui.press('Diagnostics: identity, host process and output');
    assert.ok(ui.text().includes('Caller · queue:milestone:app:failed'));
    assert.ok(ui.text().includes('epoch 2'));
    assert.ok(ui.text().includes('Commit bbbbbbbbbbbb'));
    assert.ok(ui.text().includes('Selector · qa'));
    assert.ok(ui.text().includes('qa: 1 failed, 1 cancelled; 2 identities retained, 0 omitted (diagnostics truncated)'));
    assert.ok(ui.text().includes('failed 2 expected mismatch — test/result.test.ts:8:2'));
    assert.ok(ui.text().includes('cancelled 3 cancelled child'));
    ui.type(`Teardown retry reason for run ${qaFailedId}`, 'Operator checked the retained worktree');
    assert.equal(ui.get(`Retry teardown for run ${qaFailedId}`).props.accessibilityState.disabled, false);
    ui.press(`Retry teardown for run ${qaFailedId}`);
    await settleUntil(ui, () => projectQaActions.some(action => action.method === 'project.qa.retry-teardown'), 'the detail view did not submit a teardown retry');
    assert.deepEqual(projectQaActions[0], { method: 'project.qa.retry-teardown', input: { id: qaFailedId, reason: 'Operator checked the retained worktree' } });
    ui.press('Close QA run detail');

    pressQaRow(qaQueuedId);
    ui.press(`Cancel QA run ${qaQueuedId}`);
    await settleUntil(ui, () => projectQaActions.some(action => action.method === 'project.qa.cancel'), 'the detail view did not submit QA cancellation');
    assert.deepEqual(projectQaActions[1], { method: 'project.qa.cancel', input: { id: qaQueuedId, reason: 'Cancelled from QA runs for App' } });
    ui.press('Close QA run detail');

    ui.press('Projects, All projects');
    ui.press('Project App');
    assert.ok(ui.query('QA run row qa-result-passed'), 'the project selector scopes the combined run list');
    assert.equal(ui.query('QA run row project-d-result'), undefined);
    ui.press('Projects, App');
    ui.press('Show older QA results');
    assert.ok(ui.query(`QA run row ${oldResultId}`), 'Show more reveals results older than 24 hours');
    ui.press('Run QA');
    assert.ok(ui.query('Choose a project for Run QA'));
    assert.ok(ui.query('Run QA for App'));
    assert.equal(ui.query('Run QA for Project-D'), undefined, 'the Run QA picker follows the project scope');
    ui.press('Run QA for App');
    await settleUntil(ui, () => projectQaRunRequests.length === 1, 'the project picker did not start milestone QA');
    assert.deepEqual(projectQaRunRequests, ['owner/app']);
    assertDarkTheme(ui);
    clearProjectSelection();
  } finally {
    board.projects = originalProjects;
    board.tasks = originalTasks;
    clearProjectSelection();
    hostRunsForUi = [];
    projectQaRunsForUi = [];
    projectQaActions.length = 0;
    projectQaRunRequests.length = 0;
    unmount(ui);
  }
});

/** A Spec 032 decision fixture the mutating RPC stub below can answer or withdraw. */
type DecisionFixture = Record<string, unknown> & { id: string; status: string; answer: Record<string, unknown> | null; withdrawal: Record<string, unknown> | null };
const decision = (over: Record<string, unknown>): DecisionFixture => ({
  id: 'dec-fresh', version: 1, question: 'Which branch do we cut?', headline: over.headline ?? over.question ?? 'Which branch do we cut?', context: 'Release is Friday.',
  details: 'Release is Friday.',
  choices: Object.hasOwn(over, 'choices') ? over.choices : [{ label: 'main', consequence: 'Cut from main.' }, { label: 'release', consequence: 'Cut from release.' }], recommended: over.recommended ?? 'main',
  options: ['main', 'release'], recommendation: 'Cut from main.',
  askedBy: { agentId: 'agent-asker', project: { origin: 'owner/app', path: '/app' } },
  links: { tasks: ['shared'], leads: ['lead-1'], papercuts: [] },
  status: 'open' as string, answer: null, withdrawal: null, supersededBy: null, delivery: null,
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), updatedAt: new Date().toISOString(), versions: [], stale: false, ...over,
});

test('032 the bundled Pipeline shows agent decisions and Nucleus-raised merge holds in the dark theme', async () => {
  const stamp = new Date().toISOString();
  const fresh = decision({});
  const stale = decision({ id: 'dec-stale', question: 'Still worth splitting?', stale: true, context: null, choices: undefined, options: ['Keep', 'Remove'], recommendation: null, links: { tasks: [], leads: [], papercuts: [] } });
  const withdrawable = decision({ id: 'dec-withdraw', question: 'Rename the lane?', context: null, options: [], recommendation: null,
    overtakenBy: [{ kind: 'brief_amendment', id: 'unlaned', sourceId: 'brief-v2', label: 'Brief amendment for task unlaned: updated scope', at: stamp }],
    links: { tasks: ['unlaned'], leads: [], papercuts: [] } });
  const general = decision({ id: 'dec-general', question: 'Where should this decision live?', context: null, options: [], recommendation: null,
    askedBy: { agentId: 'agent-general', project: null }, links: { tasks: ['project-d-task'], leads: [], papercuts: [] } });
  const decisions = new Map<string, DecisionFixture>([[fresh.id, fresh], [stale.id, stale], [withdrawable.id, withdrawable], [general.id, general]]);
  const answers: Array<Record<string, unknown>> = [], withdrawals: Array<Record<string, unknown>> = [];
  const originalProjects = board.projects, originalTasks = board.tasks;
  board.projects = [project, projectDProject];
  // This fixture serves its own open decisions. The board's decision read is keyed on the
  // store revision (#1011), so the store moves, as it does whenever decisions change.
  board.revision++;
  board.tasks = tasks.map(task => task.id === 'shared' ? { ...task, number: 5747, reference: 'project-a-accelerator#5747', title: 'Close the F1 and F3 checks',
    waitState: { state: 'needs_operator_input' as const, owner: 'operator', nextAction: 'Answer decision dec-fresh', decisionId: 'dec-fresh' } } : task).concat([
    { ...summary('project-d-task', 'Project-D task', [], 'working'), repoPath: projectDRepo.path, repository: projectDRepo.origin },
    { ...summary('held-task', 'Held reviewed task', ['first'], 'verifying'), held: true, holdKind: 'merge', holdEscalated: true,
      hold: { owner: 'agent-hold', reason: 'External receipt pending', since: stamp } },
  ]);
  const rpc = async (method: string, input: unknown) => {
    if (method === 'decision.list') return [...decisions.values()].filter(item => item.status === 'open');
    if (method === 'decision.get') return decisions.get((input as { id: string }).id) ?? {};
    if (method === 'decision.answer') {
      answers.push(input as Record<string, unknown>);
      const item = decisions.get((input as { id: string }).id)!;
      item.status = 'answered'; item.version = 2;
      item.answer = { text: answers.at(-1)!.answer as string, answeredBy: answers.at(-1)!.answeredBy as string, answeredAt: stamp, relayed: null, note: '' };
      return item;
    }
    if (method === 'decision.withdraw') {
      withdrawals.push(input as Record<string, unknown>);
      const item = decisions.get((input as { id: string }).id)!;
      item.status = 'withdrawn'; item.version = 2;
      item.withdrawal = { reason: withdrawals.at(-1)!.reason as string, withdrawnBy: withdrawals.at(-1)!.withdrawnBy as string, withdrawnAt: stamp };
      return item;
    }
    return invoke(method, input);
  };
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false, rpc));
  try {
    await settle(ui);
    // The Pipeline Decisions column carries four agent decisions and one
    // Nucleus-raised merge hold, without a separate navigation tab.
    assert.ok(ui.query('Decisions, 5'), 'the Pipeline column includes agent decisions and the escalated hold');
    // A Triage lead card carries no decision chip any more (Tom, 2026-11-07): its card is title, kind, project and state.
    assert.equal(countText(ui, 'Decision'), 7, `the four decision cards plus chips on the linked shared, unlaned and Project-D cards; project selector:${ui.all(/^Projects,/).map(node => node.props.accessibilityLabel).join(', ')}; decisions: ${ui.ofType('Text').map(node => node.children.join('')).filter(text => text.includes('Decision')).join(' | ')}`);
    assert.equal(countText(ui, 'Stale'), 1, 'the stale decision shows as stale, never hidden');
    assert.equal(countText(ui, 'Nucleus-raised'), 1, 'the escalated merge hold is visible in Pipeline');
    assert.ok(ui.query('Held merge: Held reviewed task'));
    assert.match(ui.text(), /Ready to merge, held for External receipt pending/);
    assert.ok(ui.get('Release'));
    assert.ok(ui.get('Keep'));
    assert.ok(ui.query('Decision: Where should this decision live?'), 'a General decision is present in the Decisions column');
    assert.equal(countText(ui, 'General'), 1, 'the General decision has its own project label');
    assert.equal(countText(ui, 'linked: project-d'), 1, 'the General decision hints at its linked task project');
    assert.match(ui.text(), /Asked 3h ago · 2 links/);
    assert.ok(ui.text().includes('Task · project-a-accelerator#5747 · Close the F1 and F3 checks'), 'decision cards name linked tasks by reference and title');
    assert.ok(ui.text().includes('Waiting on you · Which branch do we cut?'), 'linked operator waits name the decision');
    assert.ok(ui.ofType('Pressable').some(node => String(node.props.accessibilityLabel).includes('Waiting on you · Which branch do we cut?')), 'the task card accessibility label names the decision');
    // Tom, 2026-09-29: cards named the asking agent's id, not the project it came from.
    assert.ok(countText(ui, 'app') >= 3, 'each decision card names its asking project');
    assert.doesNotMatch(ui.text(), /agent-asker/, 'the raw asker id is not the card label');
    assert.doesNotMatch(ui.text(), /Choose this direction|Accept the proposed direction/, 'missing consequences never become placeholder filler');
    assert.match(ui.text(), /Cut from main\./);
    assertDarkTheme(ui);
    // The decision modal starts with the compact question and choices; full details stay collapsed.
    ui.press('Decision: Which branch do we cut?');
    await settleUntil(ui, () => ui.query('Operator answer') !== undefined, 'the decision modal did not load');
    assert.doesNotMatch(ui.text(), /Release is Friday\./, 'the long details start collapsed');
    ui.press('Details, collapsed');
    await settleUntil(ui, () => ui.text().includes('Release is Friday.'), 'the decision details did not expand');
    assert.match(ui.text(), /Release is Friday\./);
    assert.match(ui.text(), /Recommended · main — Cut from main\./, 'the first choice is marked recommended and shows its consequence');
    assert.match(ui.text(), /release — Cut from release\./, 'the other choice shows its consequence');
    assert.match(ui.text(), /Task · shared/);
    assert.match(ui.text(), /Lead · lead-1/);
    assert.equal(ui.get('Answer').props.accessibilityState.disabled, true, 'an empty answer disables the button');
    assert.equal(ui.get('Withdraw').props.accessibilityState.disabled, true);
    assertDarkTheme(ui);
    ui.type('Operator answer', 'Cut from main at noon.');
    assert.equal(ui.get('Answer').props.accessibilityState.disabled, false);
    ui.press('Answer');
    await settleUntil(ui, () => ui.query('Record action result') !== undefined, 'the answer result stayed out of the modal');
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.answeredBy, 'operator (board)', 'the board answers with operator authority');
    assert.equal(answers[0]!.relayed, false);
    assert.equal(answers[0]!.version, 1);
    // The Pipeline updates without reload: the answered decision leaves its column.
    await settleUntil(ui, () => ui.query('Decision: Which branch do we cut?') === undefined, 'the answered decision stayed on the board');
    assert.ok(ui.query('Decisions, 4'), 'the Pipeline column count dropped');
    await settleUntil(ui, () => ui.text().includes('operator authority'), 'the recorded answer did not render in the modal');
    assertDarkTheme(ui);
    ui.press('Close decision detail');
    // The withdraw path.
    ui.press('Decision: Rename the lane?');
    await settleUntil(ui, () => ui.query('Withdraw as overtaken') !== undefined, 'the overtaken decision detail did not load');
    assert.ok(ui.query(/View citing/), `the modal links to the exact citing amendment; labels: ${ui.all(/View citing/).map(node => node.props.accessibilityLabel).join(' | ')}`);
    ui.press('Withdraw as overtaken');
    await settleUntil(ui, () => ui.text().includes('Withdrawn after Brief amendment for task unlaned: updated scope'), 'the one-click withdrawal did not record');
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0]!.withdrawnBy, 'operator (board)');
    assert.equal(withdrawals[0]!.reason, 'Withdrawn after Brief amendment for task unlaned: updated scope');
    await settleUntil(ui, () => ui.query('Decision: Rename the lane?') === undefined, 'the withdrawn decision stayed on the board');
    assert.ok(ui.query('Decisions, 3'), 'the Pipeline column count dropped again');
    ui.press('Close decision detail');
    // The stale decision stays open on the board until a human withdraws it.
    assert.ok(ui.query('Decision: Still worth splitting?'));
    assert.equal(countText(ui, 'Stale'), 1);
    assert.equal(countText(ui, 'Decision'), 3, 'the stale and General decision cards keep their chips, as does the linked Project-D task');
    assertDarkTheme(ui);
    // A specific project filter keeps General in the count, its own section and the pipeline column.
    ui.press('Projects, All projects');
    assert.ok(ui.query('Project selector'));
    ui.press('Project App');
    assert.equal(ui.get(/^Projects, /).props.accessibilityLabel, 'Projects, App');
    assert.ok(ui.query('Decisions, 3'), 'the project filter count includes the remaining project decision, General and held merge');
    assert.equal(countText(ui, 'linked: project-d'), 1, 'the General task hint survives its linked project being filtered out');
    assert.equal(ui.ofType('View').find(node => node.props.accessibilityLabel === 'Decisions, 3')?.props.accessibilityLabel, 'Decisions, 3', 'the Decisions column keeps General and the held merge under a specific project filter');
    assert.equal(ui.query(/^Decisions \(/), undefined, 'agent decisions remain in Pipeline without a separate tab');
    assert.ok(ui.query('Decision: Still worth splitting?'));
    assert.ok(ui.query('Decision: Where should this decision live?'));
    assert.equal(countText(ui, 'linked: project-d'), 1);
    assertDarkTheme(ui);
  } finally {
    board.projects = originalProjects;
    board.tasks = originalTasks;
    board.revision++;
    unmount(ui);
  }
});

test('030-7 bundled dark-theme task detail offers routing before dispatch with eligible profiles and a required reason',async()=>{
  const store=new Store(':memory:');
  try{
    const queued=store.insert(submissionSchema.parse({submissionId:'routing-ui',title:'Routing UI',repoPath:'/app',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
    const started=store.insert(submissionSchema.parse({submissionId:'started-ui',title:'Started UI',repoPath:'/app',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
    store.update(started.id,{phase:'working',agentIntent:true,agentId:'worker'});
    const parked=store.insert(submissionSchema.parse({submissionId:'parked-ui',title:'Parked UI',repoPath:'/app',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff','a'.repeat(40));
    store.update(parked.id,{phase:'verifying',workspaceIntent:true,agentActive:false});
    const strong={id:'strong',name:'Strong',provider:'test',model:'strong',available:true,problem:'',notes:'',supportedThinking:[]};
    const uiBoard={...board,tasks:[summary(queued.id,'Routing UI',[], 'queued'),summary(started.id,'Started UI',[], 'working'),{...summary(parked.id,'Parked UI',[], 'verifying'),parked:true}],profiles:[strong],pool:[{profileId:'strong',enabled:true,group:'strong',roles:['worker'],weight:1,scopes:['general'],capability:'frontier'}]};
    const detail=createTaskDetailCache(store);
    let routingControl:unknown;
    let routingRequests=0, routingCompletions=0;
    const rpc=async(method:string,input:unknown)=>{
      if(method!=='queue.task')return method==='queue.ui-snapshot'?uiBoard:method==='queue.detail'?detail((input as {taskId:string}).taskId):invoke(method,input);
      routingRequests++;routingControl=input;
      // The control answers with a task, like the real RPC, and the fixture counts
      // the answer so completion is observed rather than assumed from the send.
      const answered=queued;routingCompletions++;return answered;
    };
    const MainSurface=await bundleMainSurface();
    const ui=mount(tree(MainSurface,false,rpc));
    try{
      const routingCard = () => ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).includes('Routing UI'));
      await settleUntil(ui,()=>routingCard()!==undefined,'the board never offered the queued task');
      routingCard()!.props.onPress();
      // PR #538 reads the detail in ten seconds: routing sits in the collapsed Technical group.
      await settleUntil(ui,()=>ui.query('Technical')!==undefined,'the task detail never rendered its Technical tab');
      ui.press('Technical');
      await settleUntil(ui,()=>ui.query('Change routing')!==undefined,'the queued task detail never loaded its routing control');
      assert.ok(ui.get('Change routing'));
      ui.press('Change routing');
      assert.ok(ui.get('Strong · frontier'));
      assertDarkTheme(ui);
      // The required reason gates the save, including a whitespace-only entry.
      assert.equal(ui.get('Save routing').props.accessibilityState?.disabled,true);
      ui.type('Reason (required)','   ');
      assert.equal(ui.get('Save routing').props.accessibilityState?.disabled,true,'a blank reason never enables the save');
      ui.type('Reason (required)','Operator changed route');
      assert.equal(ui.get('Save routing').props.accessibilityState?.disabled,false);
      ui.press('Save routing');
      // Semantic completion: the control answers, the surface applies the answer
      // (the routing panel closes) and the operation settles (the detail's
      // buttons are enabled again) before the detail is closed or reopened.
      await settleUntil(ui,()=>routingCompletions===1,'the routing control was never answered');
      await settleUntil(ui,()=>{
        const cancel=ui.query('Cancel task');
        return Boolean(cancel)&&cancel!.props.accessibilityState?.disabled===false&&ui.query('Reason (required)')===undefined;
      },'the completed routing control never settled the task detail');
      assert.equal(routingRequests,1,'one save sends exactly one routing control');
      assert.equal(routingCompletions,1,'the routing control answers once');
      assert.equal((routingControl as {action:string}).action,'set_routing');
      assert.equal((routingControl as {reason?:string}).reason,'Operator changed route');
      assert.equal((routingControl as {relayed?:boolean}).relayed,undefined,'the board claims no relayed authorization');
      assert.equal((routingControl as {note?:string}).note,undefined,'the board appends no authorization note');
      assert.ok(ui.query('Task detail'),'the detail stays open across the completed routing control');
      assertDarkTheme(ui);
      ui.press('Close task detail');
      assert.equal(ui.query('Task detail'),undefined,'closing the detail removes the modal');
      ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).includes('Started UI'))!.props.onPress();
      await settleUntil(ui,()=>ui.query('Close task detail')!==undefined,'the started task detail never reopened');
      assert.equal(ui.query('Change routing'),undefined,'a started task offers no routing change');
      ui.press('Close task detail');
      ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).includes('Parked UI'))!.props.onPress();
      await settleUntil(ui,()=>ui.text().includes('Parked (no slot held)'),'parked task detail omitted its slot status');
      assertDarkTheme(ui);
    }finally{unmount(ui);}
  }finally{store.close();}
});

test('026-15a bundled Pipeline record modals run each action and report in the modal', async () => {
  const stamp = '2026-09-27T00:00:00.000Z';
  const digest = `sha256:${'a'.repeat(64)}`;
  const body = '---\ntitle: Lead one\n---\n\n## Outcome\n\nShip it.\n';
  const actionLead = {
    ...lead, body, digest,
    check: { ok: false, message: 'Brief missing queue.lane', checkedAt: stamp, planningCommit: null as string | null },
  };
  const dropLead = { ...lead, id: 'lead-drop', title: 'Lead drop', body: 'Drop me' };
  const cut = { ...papercut, fix: 'Patch it' as string | null, area: 'queue' as string | null };
  const versions = (item: typeof lead) => [{
    version: item.version, title: item.title, body: item.body, author: item.author,
    createdAt: item.createdAt, digest: item.digest, check: item.check,
  }];
  const papercutPromotions: unknown[] = [];
  const rpc = async (method: string, input: unknown) => {
    if (method === 'lead.board') {
      return { cards: boardCards([actionLead, dropLead, leadFromPapercut(cut as Papercut)]).map(boardRow), links: [] };
    }
    if (method === 'lead.get') {
      const id = (input as { id: string }).id;
      const item = id === dropLead.id ? dropLead : actionLead;
      return { ...item, versions: versions(item) };
    }
    if (method === 'lead.check') {
      actionLead.check = { ok: true, message: 'Ready', checkedAt: stamp, planningCommit: 'c'.repeat(40) };
      return { ...actionLead };
    }
    if (method === 'lead.approve') {
      actionLead.approval = { version: actionLead.version, digest, approver: 'operator (board)', approvedAt: stamp, note: '', relayed: false };
      return { ...actionLead };
    }
    if (method === 'lead.promote-task') {
      actionLead.state = 'promoted';
      actionLead.targets = [{ kind: 'task' as const, repository: 'owner/app', reference: 'task-1', at: stamp }];
      return { taskId: 'task-1', reference: 'owner/app#1' };
    }
    if (method === 'lead.drop') {
      dropLead.state = 'dropped';
      dropLead.dropReason = (input as { reason: string }).reason;
      return { ...dropLead };
    }
    if (method === 'papercut.list') return cut.state === ((input as { state?: string }).state ?? 'open') ? [cut] : [];
    if (method === 'papercut.get') return { ...cut };
    if (method === 'papercut.edit') {
      const edit = input as { title?: string; area?: string; happened?: string; impact?: string; fix?: string };
      cut.title = edit.title ?? cut.title; cut.area = edit.area || null; cut.happened = edit.happened ?? cut.happened;
      cut.impact = edit.impact ?? cut.impact; cut.fix = edit.fix || null; cut.version++;
      return { ...cut };
    }
    if (method === 'papercut.promote-task') {
      papercutPromotions.push(input);
      cut.state = 'promoted';
      cut.taskId = 'task-2';
      return { taskId: 'task-2', reference: 'owner/app#2' };
    }
    if (method === 'papercut.close') {
      cut.state = 'closed';
      cut.closedReason = (input as { reason: 'completed' | 'deprecated' }).reason;
      cut.note = (input as { note: string }).note;
      return { ...cut };
    }
    return invoke(method, input);
  };
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false, rpc));
  try {
    await settleUntil(ui, () => ui.text().includes('Lead one') && ui.text().includes('Lead drop') && ui.text().includes('Cut one'), 'the 15a board did not render');
    assert.equal(ui.query('Promote'), undefined);
    ui.press('Triage: Lead one');
    await settleUntil(ui, () => ui.text().includes('Brief missing queue.lane'), 'the failing-check reason did not render');
    assert.equal(ui.get('Approve the checked version').props.accessibilityState.disabled, true);
    ui.press('Check the brief');
    await settleUntil(ui, () => ui.query('Check result') !== undefined && ui.text().includes('Checks passed'), 'check result stayed out of the modal');
    ui.press('Approve the checked version');
    await settleUntil(ui, () => ui.text().includes('Approved') && ui.get('Approve the checked version').props.accessibilityState.disabled === true, 'approve result stayed out of the modal');
    ui.press('Promote to a task');
    await settleUntil(ui, () => ui.text().includes('Promoted as owner/app#1'), 'promote result stayed out of the modal');
    ui.press('More actions');
    assert.equal(ui.get('Drop the lead').props.accessibilityState.disabled, true);
    assert.match(ui.text(), /Only open leads can be dropped; this lead is promoted/);
    ui.press('Close lead detail');
    ui.press('Triage: Lead drop');
    await settleUntil(ui, () => ui.query('More actions') !== undefined, 'the drop lead modal did not load');
    ui.press('More actions');
    await settleUntil(ui, () => ui.query('Drop reason') !== undefined, 'the drop controls did not load');
    ui.type('Drop reason', 'Not needed');
    ui.press('Drop the lead');
    await settleUntil(ui, () => ui.text().includes('Dropped'), 'drop result stayed out of the modal');
    ui.press('Close lead detail');
    ui.press('Triage: Cut one');
    await settleUntil(ui, () => ui.query('Papercut detail') !== undefined && ui.query('Close as completed') !== undefined, 'the papercut modal did not load');
    // Spec 053: Promote waits for a complexity choice, then sends it.
    assert.equal(ui.get('Promote').props.accessibilityState.disabled, true);
    assert.match(ui.text(), /Choose a complexity first/);
    ui.press('Papercut complexity high');
    await settleUntil(ui, () => ui.get('Promote').props.accessibilityState.disabled === false, 'Promote stayed disabled after choosing a complexity');
    ui.press('Promote');
    await settleUntil(ui, () => ui.text().includes('Promoted as owner/app#2'), 'papercut promote result stayed out of the modal');
    assert.equal(papercutPromotions.length, 1);
    assert.equal((papercutPromotions[0] as { board: boolean }).board, true);
    assert.equal((papercutPromotions[0] as { complexity: string }).complexity, 'high', 'the chosen complexity is sent');
    ui.press('Edit');
    await settleUntil(ui, () => ui.query('Save changes') !== undefined && ui.query('What happened') !== undefined, 'the papercut editor did not open');
    assertDarkTheme(ui);
    ui.type('Title', 'Cut corrected');
    ui.type('What happened', 'The corrected detail');
    ui.type('Area', 'queue UI');
    ui.press('Save changes');
    await settleUntil(ui, () => ui.text().includes('Saved version 2') && ui.text().includes('The corrected detail'), 'papercut edit result stayed out of the modal');
    assert.equal(cut.title, 'Cut corrected'); assert.equal(cut.version, 2); assert.equal(cut.state, 'promoted');
    ui.type('Close note', 'Done here');
    ui.press('Close as completed');
    await settleUntil(ui, () => ui.text().includes('Closed as completed'), 'close result stayed out of the modal');
    await settleUntil(ui, () => ui.text().includes('Already closed'), 'the closed papercut state did not refresh');
    const deprecated = ui.get('Close as deprecated');
    assert.equal(deprecated.props.accessibilityState.disabled, true);
    assert.match(ui.text(), /Already closed/);
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
  }
});

test('043 (a) the bundled Pipeline labels every declared wait state with owner and next action in the dark theme', async () => {
  const originalTasks = board.tasks;
  board.tasks = [
    ...originalTasks,
    { ...summary('wait-capacity', 'Capacity wait', ['first'], 'queued'), waitState: { state: 'waiting_capacity', owner: 'operator', nextAction: 'Free a task slot' } },
    { ...summary('wait-prereq', 'Prerequisite wait', ['first'], 'queued'), waitState: { state: 'waiting_prerequisite', owner: 'Queue', nextAction: 'Wait for the prerequisite to finish' } },
    { ...summary('wait-decision', 'Decision wait', ['first'], 'blocked'), waitState: { state: 'needs_operator_input', owner: 'operator', nextAction: 'Answer decision dec-9', decisionId: 'dec-9' } },
    { ...summary('wait-rights', 'Source rights wait', ['first'], 'awaiting_review'), waitState: { state: 'needs_source_rights', owner: 'operator', nextAction: 'Grant source rights' } },
    { ...summary('wait-merge', 'Merge wait', ['first'], 'verifying'), held: true, holdKind: 'merge', waitState: { state: 'merge_hold', owner: 'agent-hold', nextAction: 'Release the hold, or keep it with a reason' } },
  ];
  const labels = ['Waiting for capacity', 'Waiting for prerequisite', 'Waiting on you · operator decision', 'Needs source rights', 'Merge hold'] as const;
  try {
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, false));
    try {
      await settle(ui);
      await settleUntil(ui, () => ui.text().includes('Merge hold') && ui.text().includes('Needs source rights'), 'the wait-state labels did not render');
      for (const label of labels) assert.equal(countText(ui, label), 1, `${label} renders once`);
      assert.equal(countText(ui, 'Merge held'), 0, 'the wait-state merge hold replaces the duplicate Spec 040 badge');
      const card = ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).startsWith('app, Capacity wait, Queued, Waiting for capacity'));
      assert.ok(card, 'the card label names the wait state');
      const badge = ui.ofType('View').find(node => String(node.props.accessibilityLabel ?? '').startsWith('Wait state: Waiting for capacity'));
      assert.ok(badge, 'the wait-state badge is accessible');
      assert.match(String(badge.props.accessibilityLabel), /owner operator; next Free a task slot/);
      assert.ok(ui.ofType('View').some(node => /Wait state: Waiting for prerequisite; owner Nucleus;/.test(String(node.props.accessibilityLabel ?? ''))), 'the persisted Queue owner is shown as Nucleus');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  } finally {
    board.tasks = originalTasks;
  }
});

test('decision waits use readable fallback labels in narrow and wide cards', async () => {
  const originalTasks = board.tasks;
  const waitTask = { ...summary('operator-wait', 'Operator wait', ['first'], 'blocked'),
    waitState: { state: 'needs_operator_input' as const, owner: 'operator', nextAction: 'Answer decision dec-operator', decisionId: 'dec-operator' } };
  board.tasks = [...originalTasks, waitTask];
  const item = decision({ id: 'dec-operator', headline: 'Choose the release window', question: 'Choose the release window', options: [], choices: [], recommendation: null,
    links: { tasks: ['operator-wait'], leads: [], papercuts: [] } });
  const rpc = async (method: string, input: unknown) => method === 'decision.list' ? [item] : invoke(method, input);
  try {
    const MainSurface = await bundleMainSurface();
    for (const compact of [true, false]) {
      const ui = mount(tree(MainSurface, compact, rpc));
      try {
        await settle(ui);
        assert.ok(ui.text().includes('Waiting on you · operator decision'), 'the operator wait fallback stays readable when its title is unavailable');
        const card = ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).includes('Operator wait'));
        assert.ok(card);
        assert.match(String(card.props.accessibilityLabel), /Waiting on you · operator decision/);
        const badge = ui.ofType('View').find(node => node.props.accessibilityLabel === 'Waiting on you · operator decision');
        assert.ok(badge, 'the badge accessibility label uses the same plain wording');
        assert.doesNotMatch(String(card.props.accessibilityLabel), /dec-operator/);
      } finally { unmount(ui); }
    }
  } finally { board.tasks = originalTasks; }
});

test('043 (a) bundled dark-theme task detail names the derived wait, its owner and next action', async () => {
  const store = new Store(':memory:');
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'wait-detail', title: 'Wait detail', repoPath: '/app', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    // Spec 043 (a2): the capacity wait is a current admission fact, not reason
    // text. The reason is deliberately unrelated so only the fact can derive it.
    store.update(task.id, { reason: 'Dispatched into the queue' });
    const capacityReason = `${CAPACITY_WAIT_PREFIX} Global concurrent task-slot limit reached`;
    const detail = createTaskDetailCache(store, { slotAdmissionReason: () => capacityReason });
    const uiBoard = { ...board, tasks: [...board.tasks, summarizeTask(store.task(task.id), false, false, { slotAdmissionReason: capacityReason })] };
    const rpc = async (method: string, input: unknown) => method === 'queue.ui-snapshot' ? uiBoard : method === 'queue.detail' ? detail((input as { taskId: string }).taskId) : invoke(method, input);
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, false, rpc));
    try {
      await settle(ui);
      const waitCard = ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel).startsWith('app, Wait detail, Queued, Waiting for capacity'));
      assert.ok(waitCard, 'the capacity wait card remains available');
      waitCard!.props.onPress();
      // The Overview opens first and leads with the wait: its state, owner and next action.
      await settleUntil(ui, () => Boolean(ui.query(/^Wait: /)), 'the task detail omitted its wait state');
      assert.match(String(ui.query(/^Wait: /)?.props.accessibilityLabel), /^Wait: Waiting for capacity; owner operator; next .+$/, 'the Overview names the capacity wait, its owner and next action');
      assert.ok(ui.text().includes('Waiting for capacity'), 'the wait state is visible on the Overview');
      // Technical no longer repeats the wait state; its reference stays there.
      await settleUntil(ui,()=>ui.query('Technical')!==undefined,'the task detail never rendered its Technical tab');
      ui.press('Technical');
      await settleUntil(ui, () => ui.query('Technical')?.props.accessibilityState?.selected === true, 'the Technical tab did not open');
      // The board card behind the sheet keeps its own wait badge; the detail's visible wait line is what must not repeat.
      assert.equal(ui.text().includes('· next:'), false, 'the wait state is not repeated on Technical');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  } finally { store.close(); }
});

test('051 bundled dark-theme board marks an interactive task, and says when it is the operator\'s turn', async () => {
  const store = new Store(':memory:');
  try {
    const add = (id: string, title: string) => store.insert(submissionSchema.parse({ submissionId: id, title, repoPath: '/app', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin', interactive: true }), 'host', 'handoff', 'a'.repeat(40));
    const running = store.update(add('interactive-running', 'Interactive running').id, { phase: 'working', agentId: 'worker-a', reason: 'Interactive session: the worker is running' });
    const waiting = add('interactive-waiting', 'Interactive waiting');
    const stop = { reason: 'interactive' as const, detail: "Interactive session: waiting for the operator in the worker's thread", since: new Date().toISOString(), suggestedVerbs: [] };
    store.update(waiting.id, { phase: 'working', agentId: 'worker-b', reason: stop.detail, resolution: { ...waiting.resolution, stop } });
    const uiBoard = { ...board, tasks: [...board.tasks, summarizeTask(store.task(running.id)), summarizeTask(store.task(waiting.id))] };
    const rpc = async (method: string, input: unknown) => method === 'queue.ui-snapshot' ? uiBoard : invoke(method, input);
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, false, rpc));
    try {
      await settle(ui);
      assert.equal(countText(ui, 'Interactive'), 1, 'a running session shows the plain badge');
      assert.equal(countText(ui, 'Interactive · your turn'), 1, 'an idle session says it waits on the operator');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  } finally { store.close(); }
});

/** Finding 1 (nucleus-ui, 2026-11-08): an empty column is a labelled stub at both widths and expands once it holds a card. */
const headerText = (node: HostNode): string => node.children.map(child => typeof child === 'string' ? child : headerText(child)).join('');
for (const compact of [false, true]) {
  test(`finding 1 bundled Pipeline collapses empty columns to labelled stubs at the ${compact ? 'narrow' : 'wide'} viewport`, async () => {
    const uiBoard = { ...board, tasks: [summary('stub-working', 'Working task', ['first'], 'working'), summary('stub-queued', 'Queued task', ['first'], 'queued')] };
    const noLeads = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return uiBoard;
      if (method === 'papercut.list') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      return invoke(method, input);
    };
    const headerLabels = (ui: ReturnType<typeof mount>) => ui.ofType('View')
      .map(node => node.props.accessibilityLabel)
      .filter((label): label is string => typeof label === 'string' && /^(Triage|Decisions|Attention|Queued|Working|Review|Closing), \d+/.test(label));
    const header = (ui: ReturnType<typeof mount>, label: string) => {
      const node = ui.ofType('View').find(view => view.props.accessibilityLabel === label);
      assert.ok(node, `${label} header renders`);
      return node;
    };
    const widthOf = (ui: ReturnType<typeof mount>, label: string) => (header(ui, label).props.style as { width: number }).width;
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, compact, noLeads));
    try {
      await settleUntil(ui, () => ui.ofType('Text').some(node => node.children.join('') === 'Queued task'), 'the populated columns did not render');
      assert.deepEqual(headerLabels(ui), [
        'Triage, 0, empty', 'Decisions, 0, empty', 'Attention, 0, empty', 'Queued, 1', 'Working, 1', 'Review, 0, empty', 'Closing, 0, empty',
      ], 'pipeline order holds, and each empty column says it is empty with its real total');
      assert.equal(headerText(header(ui, 'Triage, 0, empty')), 'Triage', 'a stub shows only its name');
      assert.equal(headerText(header(ui, 'Decisions, 0, empty')), 'Decisions', 'the collapsed Decisions header has no count badge');
      assert.equal(headerText(header(ui, 'Closing, 0, empty')), 'Closing');
      for (const label of ['Triage, 0, empty', 'Decisions, 0, empty', 'Attention, 0, empty', 'Review, 0, empty', 'Closing, 0, empty']) {
        assert.equal((header(ui, label).props.style as { flexDirection: string }).flexDirection, 'row', `${label} keeps the same header line as populated columns`);
      }
      assert.equal(ui.all(/^Filter Triage by tag/).length, 0, 'a stub carries no tag filter');
      for (const label of ['Triage, 0, empty', 'Decisions, 0, empty', 'Attention, 0, empty', 'Review, 0, empty', 'Closing, 0, empty']) assert.equal(widthOf(ui, label), pipelineStubWidth, `${label} is a slim stub`);
      const open = widthOf(ui, 'Queued, 1');
      assert.equal(widthOf(ui, 'Working, 1'), open, 'populated columns share the width the stubs leave');
      assert.ok(open >= (compact ? 260 : 300), 'a populated column keeps a card width');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
    // A card in Triage expands its stub back to a populated width; the other empty columns stay stubs.
    const withLead = async (method: string, input: unknown) => method === 'queue.ui-snapshot' ? uiBoard : invoke(method, input);
    const expanded = mount(tree(MainSurface, compact, withLead));
    try {
      await settleUntil(expanded, () => expanded.ofType('Text').some(node => node.children.join('') === 'Lead one'), 'the Triage card did not render');
      const triage = expanded.ofType('View').find(view => /^Triage, [1-9]\d*$/.test(String(view.props.accessibilityLabel ?? '')));
      assert.ok(triage, 'Triage expands once it holds a card');
      assert.equal((triage.props.style as { width: number }).width, widthOf(expanded, 'Queued, 1'), 'the expanded column takes a populated width');
      assert.ok(expanded.ofType('View').some(view => view.props.accessibilityLabel === 'Decisions, 0, empty'), 'other empty columns stay stubs');
      assert.equal(headerText(columnHeader(expanded, 'Decisions, 0, empty')), 'Decisions', 'the stub name stays on one line between populated Triage and Queued columns');
      assert.equal(headerText(columnHeader(expanded, 'Attention, 0, empty')), 'Attention', 'the second stub between populated columns also shows only its name');
    } finally { unmount(expanded); }
  });
}

/** Column headers in pipeline order, from their accessible labels. */
const columnHeaders = (ui: ReturnType<typeof mount>, pattern: RegExp) => ui.ofType('View')
  .map(node => node.props.accessibilityLabel)
  .filter((label): label is string => typeof label === 'string' && pattern.test(label));
const columnHeader = (ui: ReturnType<typeof mount>, label: string) => {
  const node = ui.ofType('View').find(view => view.props.accessibilityLabel === label);
  assert.ok(node, `${label} header renders`);
  return node;
};
const columnWidth = (ui: ReturnType<typeof mount>, label: string) => (columnHeader(ui, label).props.style as { width: number }).width;
const COLUMN_HEADER = /^(Triage|Decisions|Attention|Queued|Working|Review|Closing), /;

// Finding 1 (nucleus-ui): the stub rule only speaks for a loaded board. A loading or failed read has zero
// totals, so it must keep every column open and must never read "empty".
for (const compact of [false, true]) {
  const viewport = compact ? 'narrow' : 'wide';
  test(`finding 1 a board still loading keeps every column open and reads loading, not empty, at the ${viewport} viewport`, async () => {
    const pending = async (method: string, input: unknown) => method === 'queue.ui-snapshot' ? new Promise(() => {}) : invoke(method, input);
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, compact, pending));
    try {
      await settleUntil(ui, () => ui.query('Triage, loading') !== undefined, 'the loading header did not render');
      assert.deepEqual(columnHeaders(ui, COLUMN_HEADER), pipelineColumns.map(name => `${name}, loading`), 'every column is open and says loading');
      assert.equal(columnHeaders(ui, /empty$/).length, 0, 'no column reads empty before the board loads');
      const width = columnWidth(ui, 'Triage, loading');
      assert.notEqual(width, pipelineStubWidth, 'a loading column is not a stub');
      for (const name of pipelineColumns) assert.equal(columnWidth(ui, `${name}, loading`), width, `${name} keeps the open width while loading`);
      assert.ok(headerText(columnHeader(ui, 'Triage, loading')).startsWith('Triage…'), 'the count is a placeholder, not a zero total');
      assert.ok(ui.text().includes('Loading pipeline…'), 'the body says the pipeline is loading');
      assert.equal(ui.query(/^No planning records match/), undefined, 'loading is not reported as no records');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  });

  test(`finding 1 a failed board read says not loaded, never empty, at the ${viewport} viewport`, async () => {
    const failing = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') throw new Error('Snapshot read refused');
      return invoke(method, input);
    };
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, compact, failing, true));
    try {
      await settleUntil(ui, () => ui.query('Triage, not loaded') !== undefined, 'the failed header did not render');
      assert.deepEqual(columnHeaders(ui, COLUMN_HEADER), pipelineColumns.map(name => `${name}, not loaded`), 'every column says not loaded');
      assert.equal(columnHeaders(ui, /empty$/).length, 0, 'a failed read never reads empty');
      assert.ok(headerText(columnHeader(ui, 'Triage, not loaded')).startsWith('Triage—'), 'the count is a dash, not a zero total');
      for (const name of pipelineColumns) assert.notEqual(columnWidth(ui, `${name}, not loaded`), pipelineStubWidth, `${name} stays open`);
      assert.ok(ui.text().includes('The board could not be read; see the error above.'), 'the body names the failed read');
      assert.ok(ui.text().includes('Snapshot read refused'), 'the failure is shown with the error banner');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  });

  test(`finding 1 long content keeps the populated columns at card width and the stubs intact at the ${viewport} viewport`, async () => {
    const longTitle = 'A task title written at length, so that it runs well past what a narrow column can hold and has to clamp to two lines '.repeat(3).trim();
    const uiBoard = { ...board, tasks: [summary('long-working', longTitle, ['first'], 'working'), summary('short-queued', 'Short queued task', ['first'], 'queued')] };
    const longContent = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return uiBoard;
      if (method === 'papercut.list') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      return invoke(method, input);
    };
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, compact, longContent));
    try {
      await settleUntil(ui, () => ui.ofType('Text').some(node => node.children.join('') === 'Short queued task'), 'the long-content board did not render');
      assert.deepEqual(columnHeaders(ui, COLUMN_HEADER), ['Triage, 0, empty', 'Decisions, 0, empty', 'Attention, 0, empty', 'Queued, 1', 'Working, 1', 'Review, 0, empty', 'Closing, 0, empty']);
      const open = columnWidth(ui, 'Queued, 1');
      assert.equal(columnWidth(ui, 'Working, 1'), open, 'the long card does not widen its column');
      assert.ok(open >= (compact ? 260 : 300), 'a populated column keeps a card width');
      for (const label of ['Triage, 0, empty', 'Review, 0, empty']) assert.equal(columnWidth(ui, label), pipelineStubWidth, `${label} stays a stub next to long content`);
      const title = ui.ofType('Text').find(node => node.children.join('') === longTitle);
      assert.ok(title, 'the long title renders in full in the card');
      assert.equal(title.props.numberOfLines, 2, 'the card clamps a long title to two lines');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  });

  // Tom, 2026-11-08: the swim-lane view is retired. An empty board and a long column of cards in
  // several lanes both render as the one set of columns, with real totals and no lane controls.
  test(`the board has no swim-lane view: empty, and a long column of multi-lane cards, at the ${viewport} viewport`, async () => {
    const respond = (uiBoard: unknown) => async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return uiBoard;
      if (method === 'papercut.list') return [];
      if (method === 'lead.board') return { cards: [], links: [] };
      return invoke(method, input);
    };
    const MainSurface = await bundleMainSurface();
    const empty = mount(tree(MainSurface, compact, respond({ ...board, tasks: [], pendingSubmissions: [], qaRuns: [] })));
    try {
      await settleUntil(empty, () => empty.text().includes('No planning records match the selected projects.'), 'the empty board did not render');
      assert.deepEqual(columnHeaders(empty, COLUMN_HEADER), pipelineColumns.map(name => `${name}, 0, empty`), 'every column reads its real zero total');
      assert.equal(empty.query('Lanes'), undefined, 'no Lanes switch');
      assert.ok(empty.query(/^Projects, /), 'the project selector stays in the header');
      assertDarkTheme(empty);
    } finally { unmount(empty); }
    const many = Array.from({ length: 40 }, (_, index) => summary(`multi-${index}`, `Multi-lane task ${index}`, index % 2 ? ['first', 'second'] : ['second'], 'queued'));
    const ui = mount(tree(MainSurface, compact, respond({ ...board, tasks: many })));
    try {
      await settleUntil(ui, () => ui.ofType('Text').some(node => node.children.join('') === 'Multi-lane task 39'), 'the long column did not render');
      assert.ok(ui.query('Queued, 40'), 'the header counts each card once');
      for (let index = 0; index < 40; index++) assert.equal(countText(ui, `Multi-lane task ${index}`), 1, `card ${index} renders once`);
      assert.equal(ui.query(/lane, \d+ cards/), undefined, 'no swim-lane row headers');
      assert.equal(ui.query(/^\d+ more$/), undefined, 'no five-card cell: the column scrolls instead');
      assert.equal(ui.query(/^Collapse /), undefined, 'no per-cell collapse control');
      assertDarkTheme(ui);
    } finally { unmount(ui); }
  });
}
