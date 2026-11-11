import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../core/host/adapter';
import { buildProjectSettings, PROJECT_SETTINGS_PROBLEMS } from '../core/planning/project-settings';
import { QueueRuntime } from '../service/runtime-owner';
import {
  DEFAULT_PROJECT_LIMIT,
  ownerCandidateKind,
  PROJECT_OWNER_CANDIDATE_KINDS,
  projectOwnerCandidates,
  projectOwnerCandidateSchema,
  projectQaRunSchema,
  projectSchema,
  projectSettings,
  projectSettingsSchema,
  repositorySettingsSchema,
  type Project,
  type ProjectQaRun,
  type RepositorySettings,
} from '../shared/contracts';
import { wireLabels } from '../shared/wire-labels';

const alpha = { origin: 'acme/alpha', path: '/repos/alpha' };
const beta = { origin: 'acme/beta', path: '/repos/beta' };

function project(input: {
  key: string;
  repositories?: Array<{ origin: string | null; path: string }>;
  primary?: { origin: string | null; path: string };
  planner?: { agentId: string; setBy?: string; setAt?: string } | null;
}): Project {
  const repositories = input.repositories ?? [alpha];
  return projectSchema.parse({
    key: input.key,
    name: input.key,
    repositories,
    primary: input.primary ?? repositories[0],
    planner: input.planner
      ? { agentId: input.planner.agentId, setBy: input.planner.setBy ?? 'operator', setAt: input.planner.setAt ?? '2026-11-08T00:00:00.000Z' }
      : input.planner === null ? null : undefined,
  });
}

function settingsRow(repository: { origin: string | null; path: string }, revision = 1): RepositorySettings {
  return repositorySettingsSchema.parse({
    repository, note: 'row', updatedAt: '2026-11-08T00:00:00.000Z', revision,
  });
}

function qaRun(input: {
  id: string;
  key: string;
  state: ProjectQaRun['state'];
  startedAt: string;
  finishedAt?: string | null;
  origin?: string;
  path?: string;
}): ProjectQaRun {
  return projectQaRunSchema.parse({
    id: input.id,
    key: input.key,
    repository: { origin: input.origin ?? input.key, path: input.path ?? `/repos/${input.id}` },
    state: input.state,
    baseBranch: 'main',
    base: 'a'.repeat(40),
    argv: ['effigy', 'qa'],
    digest: 'b'.repeat(64),
    capacityWait: null,
    capacityUnavailable: false,
    exitCode: input.state === 'passed' ? 0 : input.state === 'failed' ? 1 : null,
    durationMs: 0,
    outputTail: input.state,
    startedAt: input.startedAt,
    submittedAt: input.startedAt,
    finishedAt: input.finishedAt === undefined
      ? (input.state === 'queued' || input.state === 'running' ? null : input.startedAt)
      : input.finishedAt,
    pid: null,
  });
}

function settings(input: Parameters<typeof buildProjectSettings>[0]) {
  return projectSettingsSchema.parse(buildProjectSettings(input));
}

test('ownerCandidateKind classifies planners apart from task threads', () => {
  assert.equal(ownerCandidateKind(undefined), 'planner');
  assert.equal(ownerCandidateKind({}), 'planner');
  assert.equal(ownerCandidateKind(wireLabels({})), 'planner');
  assert.equal(ownerCandidateKind(wireLabels({ role: 'worker', task: 't1', run: 'r1' })), 'worker');
  assert.equal(ownerCandidateKind(wireLabels({ task: 't1', run: 'r1' })), 'worker');
  // A thread created before Nucleus carries only the recorded label; it is history, not a live alias.
  assert.equal(ownerCandidateKind({ 'northstar.task': 't1' }), 'planner');
  assert.equal(ownerCandidateKind(wireLabels({ role: 'reviewer', task: 't1', run: 'r1', reviewer: 'rev' })), 'reviewer');
  assert.equal(ownerCandidateKind(wireLabels({ reviewer: 'rev' })), 'reviewer');
  assert.equal(ownerCandidateKind(wireLabels({ role: 'recovery', task: 't1' })), 'recovery');
  assert.equal(ownerCandidateKind(wireLabels({ role: 'closeout', task: 't1' })), 'closeout');
  assert.equal(ownerCandidateKind(wireLabels({ role: 'coordinator', task: 't1' })), 'coordinator');
  assert.equal(ownerCandidateKind(wireLabels({ role: 'executor', task: 't1' })), 'executor');
  assert.equal(ownerCandidateKind(wireLabels({ decider: 'q1' })), 'other');
  assert.equal(ownerCandidateKind({ 'nucleus.role': 'worker', 'northstar.role': 'reviewer' }), 'other');
  assert.deepEqual([...PROJECT_OWNER_CANDIDATE_KINDS], [
    'planner', 'worker', 'reviewer', 'recovery', 'closeout', 'coordinator', 'executor', 'other',
  ]);
});

test('project.owner-candidates requires kind and refuses a candidate without one', () => {
  const candidate = { id: 'agent', title: 'Planner', workspaceId: 'ws', kind: 'planner' as const };
  assert.deepEqual(projectOwnerCandidateSchema.parse(candidate), candidate);
  assert.equal(projectOwnerCandidateSchema.safeParse({ id: 'agent', title: 'Planner', workspaceId: null }).success, false);
  assert.equal(projectOwnerCandidates.output.safeParse([candidate]).success, true);
});

test('project.settings inherits slots, flags planner and QA problems, and matches repository rows', () => {
  const live = project({ key: 'live', planner: { agentId: 'planner-live' } });
  const gone = project({ key: 'gone', planner: { agentId: 'planner-gone' } });
  const empty = project({ key: 'empty', repositories: [alpha, beta], primary: alpha });
  const row = settings({
    projects: [live, gone, empty],
    repositories: [settingsRow(alpha)],
    overrides: { gone: 2 },
    defaultSlots: DEFAULT_PROJECT_LIMIT,
    liveAgentIds: new Set(['planner-live']),
    liveKnown: true,
    latestQaRuns: [
      qaRun({ id: 'qa-alpha', key: alpha.origin, state: 'passed', startedAt: '2026-11-08T02:00:00.000Z' }),
      qaRun({ id: 'qa-beta', key: beta.origin, state: 'failed', startedAt: '2026-11-08T01:00:00.000Z' }),
    ],
  });
  assert.equal(row.defaultSlots, DEFAULT_PROJECT_LIMIT);
  assert.equal('inFlight' in row, false);

  const liveRow = row.projects[0];
  assert.deepEqual(liveRow.slots, { value: DEFAULT_PROJECT_LIMIT, override: null });
  assert.equal(liveRow.plannerLive, true);
  assert.deepEqual(liveRow.problems, []);
  assert.equal(liveRow.repositories[0].primary, true);
  assert.equal(liveRow.repositories[0].settings?.repository.origin, alpha.origin);

  const goneRow = row.projects[1];
  assert.deepEqual(goneRow.slots, { value: 2, override: 2 });
  assert.equal(goneRow.plannerLive, false);
  assert.deepEqual(goneRow.problems, [PROJECT_SETTINGS_PROBLEMS.plannerGone]);

  const emptyRow = row.projects[2];
  assert.equal(emptyRow.plannerLive, null);
  assert.deepEqual(emptyRow.problems, [PROJECT_SETTINGS_PROBLEMS.noPlanner, PROJECT_SETTINGS_PROBLEMS.qaFailed]);
  assert.deepEqual(emptyRow.latestQa, {
    key: alpha.origin, state: 'passed', startedAt: '2026-11-08T02:00:00.000Z', finishedAt: '2026-11-08T02:00:00.000Z',
  });
  assert.equal(emptyRow.repositories[0].primary, true);
  assert.equal(emptyRow.repositories[1].primary, false);
  assert.equal(emptyRow.repositories[1].settings, null);
  assert.equal('inFlight' in emptyRow, false);
});

test('project.settings treats unknown live inventory as unknown, not gone, and timed-out QA is not a failed last run', () => {
  const named = project({ key: 'named', planner: { agentId: 'planner' } });
  const unknown = settings({
    projects: [named],
    repositories: [],
    overrides: {},
    defaultSlots: 5,
    liveAgentIds: new Set(),
    liveKnown: false,
    latestQaRuns: [qaRun({ id: 'qa', key: alpha.origin, state: 'timed_out', startedAt: '2026-11-08T00:00:00.000Z' })],
  });
  assert.equal(unknown.projects[0].plannerLive, null);
  assert.deepEqual(unknown.projects[0].problems, []);
  assert.equal(unknown.projects[0].latestQa?.state, 'timed_out');
});

function liveAdapter(
  dir: string,
  live: () => Array<{ id: string; title: string; workspaceId: string | null; labels?: Record<string, string> }>,
  options: { throwLive?: boolean } = {},
): Adapter {
  return {
    client: { isConnected: true },
    hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'),
    helperPath: join(dir, 'helper.mjs'),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    listLiveAgents: async () => {
      if (options.throwLive) throw new Error('Live agent inventory was incomplete');
      return live();
    },
  } as unknown as Adapter;
}

function muteAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'),
    helperPath: join(dir, 'helper.mjs'),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
}

test('project.owner-candidates returns classified live threads and an empty list when the host cannot list them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-owner-candidates-'));
  const live = [
    { id: 'planner', title: 'Nucleus', workspaceId: 'ws', labels: wireLabels({}) },
    { id: 'worker', title: 'Worker', workspaceId: 'ws', labels: wireLabels({ role: 'worker', task: 't1', run: 'r1' }) },
    { id: 'reviewer', title: 'Review', workspaceId: null, labels: wireLabels({ role: 'reviewer', reviewer: 'rev' }) },
    { id: 'recovery', title: 'Recovery', workspaceId: 'ws', labels: wireLabels({ role: 'recovery', task: 't1' }) },
  ];
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => liveAdapter(dir, () => live), timers: false });
  try {
    await runtime.started;
    const candidates = projectOwnerCandidates.output.parse(await runtime.projectOwnerCandidates());
    assert.deepEqual(candidates.map(entry => ({ id: entry.id, kind: entry.kind })), [
      { id: 'planner', kind: 'planner' },
      { id: 'worker', kind: 'worker' },
      { id: 'reviewer', kind: 'reviewer' },
      { id: 'recovery', kind: 'recovery' },
    ]);
    assert.equal('labels' in candidates[0], false);
  } finally { await runtime.stop(); }

  const muteDir = mkdtempSync(join(tmpdir(), 'nsq-owner-candidates-mute-'));
  const mute = new QueueRuntime({ dataDir: muteDir, adapterFactory: () => muteAdapter(muteDir), timers: false });
  try {
    await mute.started;
    assert.deepEqual(await mute.projectOwnerCandidates(), []);
  } finally { await mute.stop(); }
});

test('project.settings is one store-and-live read through the owner, and an incomplete live list fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-settings-rpc-'));
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => liveAdapter(dir, () => [{ id: 'planner-live', title: 'Planner', workspaceId: 'ws' }]),
    timers: false,
  });
  try {
    await runtime.started;
    runtime.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    runtime.store.setProjectPlanner({ key: 'suite', agentId: 'planner-live', setBy: 'operator' });
    runtime.store.setProjectDispatchLimitOverride('suite', 3);
    runtime.store.putRepository(alpha, null, 'alpha-row');
    runtime.store.putQaRun(qaRun({
      id: 'qa-suite', key: alpha.origin, state: 'failed', startedAt: '2026-11-08T00:00:00.000Z',
    }));
    const page = projectSettings.output.parse(await runtime.projectSettings());
    assert.equal(page.defaultSlots, DEFAULT_PROJECT_LIMIT);
    const suite = page.projects.find(entry => entry.project.key === 'suite');
    assert.ok(suite);
    assert.deepEqual(suite.slots, { value: 3, override: 3 });
    assert.equal(suite.plannerLive, true);
    assert.equal(suite.latestQa?.state, 'failed');
    assert.deepEqual(suite.problems, [PROJECT_SETTINGS_PROBLEMS.qaFailed]);
    assert.equal(suite.repositories[0].settings?.note, 'alpha-row');
    assert.equal(suite.repositories[1].settings, null);
  } finally { await runtime.stop(); }

  const throwDir = mkdtempSync(join(tmpdir(), 'nsq-project-settings-throw-'));
  const failing = new QueueRuntime({
    dataDir: throwDir,
    adapterFactory: () => liveAdapter(throwDir, () => [], { throwLive: true }),
    timers: false,
  });
  try {
    await failing.started;
    failing.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] });
    await assert.rejects(() => failing.projectSettings(), /Live agent inventory was incomplete/);
  } finally { await failing.stop(); }

  const muteDir = mkdtempSync(join(tmpdir(), 'nsq-project-settings-mute-'));
  const mute = new QueueRuntime({ dataDir: muteDir, adapterFactory: () => muteAdapter(muteDir), timers: false });
  try {
    await mute.started;
    mute.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] });
    mute.store.setProjectPlanner({ key: 'suite', agentId: 'planner-gone', setBy: 'operator' });
    const page = await mute.projectSettings();
    assert.equal(page.projects[0].plannerLive, null);
    assert.deepEqual(page.projects[0].problems, []);
  } finally { await mute.stop(); }
});

test('project.settings keeps a project latest QA when 250 newer other-repository runs would drop it from the board inventory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-settings-qa-cap-'));
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => muteAdapter(dir), timers: false });
  try {
    await runtime.started;
    runtime.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] });
    runtime.store.putQaRun(qaRun({
      id: 'qa-suite', key: alpha.origin, state: 'failed', startedAt: '2026-10-01T00:00:00.000Z',
    }));
    for (let i = 0; i < 250; i++) {
      runtime.store.putQaRun(qaRun({
        id: `fill-${i}`, key: `acme/fill-${i}`, state: 'passed', startedAt: '2026-11-08T12:00:00.000Z',
      }));
    }
    assert.equal(runtime.store.latestQaRuns().some(run => run.key === alpha.origin), false);
    const page = projectSettings.output.parse(await runtime.projectSettings());
    const suite = page.projects.find(entry => entry.project.key === 'suite');
    assert.ok(suite);
    assert.equal(suite.latestQa?.key, alpha.origin);
    assert.equal(suite.latestQa?.state, 'failed');
    assert.deepEqual(suite.problems, [PROJECT_SETTINGS_PROBLEMS.noPlanner, PROJECT_SETTINGS_PROBLEMS.qaFailed]);
  } finally { await runtime.stop(); }
});


test('project.upsert with create refuses an existing key atomically: a stale list never rewrites another project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-create-'));
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => muteAdapter(dir), timers: false });
  const gamma = { origin: 'acme/gamma', path: '' };
  try {
    await runtime.started;
    // Another client created "suite" after this client's list loaded.
    const existing = runtime.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    runtime.store.setProjectPlanner({ key: 'suite', agentId: 'planner-suite', setBy: 'operator' });
    const before = runtime.store.projectByKey('suite');
    // The stale client picks the same key with a new primary that would replace the membership.
    assert.throws(() => runtime.store.upsertProject({ key: 'suite', name: 'Other', repositories: [gamma, alpha], primary: gamma, create: true }),
      /Project suite already exists\. Nothing changed/);
    assert.deepEqual(runtime.store.projectByKey('suite'), before, 'the existing project, its membership and planner are untouched');
    assert.equal(before?.version, existing.version);
    assert.equal(runtime.store.projectFor('', 'acme/gamma')?.key ?? null, null, 'no default project was made for the refused repository either');
    // A free key creates; without create the call stays an upsert.
    const made = runtime.store.upsertProject({ key: 'suite-2', name: 'Other', repositories: [gamma], create: true });
    assert.equal(made.version, 1);
    assert.equal(runtime.store.upsertProject({ key: 'suite', name: 'Suite renamed', repositories: [alpha, beta], primary: alpha }).name, 'Suite renamed');
  } finally { await runtime.stop(); }
});
