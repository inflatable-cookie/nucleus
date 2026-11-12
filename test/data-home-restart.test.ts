import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketFixtureDirectory } from './support/socket-fixture';
import { Store } from '../core/store/store';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo, serviceInfoPath } from '../service/transport/identity';
import { submissionSchema, runSchema } from '../shared/contracts';
import { nucleusProfileSchema } from '../shared/profiles';
import { DATA_HOME_ENTRIES, DATA_HOME_ENV, resolveDataHome } from '../shared/data-home.mjs';

/**
 * Author proof: the live leftover layout, opened by the real standalone service
 * twice, through the post-move resolver.
 *
 * The fixture is the live machine after the 2026-11-09 move: `HOME=<root>/home`,
 * the store at `<home>/.nucleus`, a leftover `~/.nucleus-stage-journal.json`, and
 * a sealed `~/.paseo/northstar-queue` with `.nucleus-redirect.json`. No
 * `NUCLEUS_DATA_HOME`, no `--data-dir`. The resolver must find `~/.nucleus` and
 * ignore the journal and the sealed old view.
 *
 * What it demonstrates:
 *  - records: a task, a reviewer run, events and credentials are byte-identical after
 *    two service restarts;
 *  - settings: `settings.json` and `runners.json` are byte-identical;
 *  - profiles, subscriptions (the pool), the nine capacity limits and the pause state
 *    are identical, both in the store and as the live service reports them;
 *  - the service's own snapshot confirms it opened that store (pause, limits, task).
 *
 * Nothing here touches a real data home: every path is inside a fresh fixture under
 * TMPDIR, and the child processes get a stripped environment.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const base = 'b'.repeat(40);

const CAPACITY = {
  globalLimit: 7, projectLimit: 3, papercutProjectLimit: 2, paseoCallLimit: 9,
  stallThresholdMinutes: 5, holdReminderMinutes: 90, holdEscalationMinutes: 150,
  laneDrainMinutes: 45, laneDrainEscalationMinutes: 75,
} as const;

const PROFILES = [
  { id: 'fixture-worker', name: 'Fixture worker', provider: 'fixture', model: 'fixture/worker', notes: 'kept across the move' },
  { id: 'fixture-reviewer', name: 'Fixture reviewer', provider: 'fixture', model: 'fixture/reviewer', notes: '' },
];

/** Two subscription entries (the pool), with their roles and scope. */
const POOL = [
  { profileId: 'fixture-worker', enabled: true, group: 'fixture-worker', roles: ['worker'], weight: 2, scopes: ['general'], capability: 'high', cost: 'medium' },
  { profileId: 'fixture-reviewer', enabled: true, group: 'fixture-reviewer', roles: ['reviewer'], weight: 1, scopes: ['general'] },
];

function childEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    [DATA_HOME_ENV]: '',
    QUEUE_LOGIN_SESSION: 'data-home-proof',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  };
}

interface ServiceProcess { child: ChildProcess; output(): string }

function startService(home: string, dataDir: string): ServiceProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'bin', 'queue-service.mjs')], {
    cwd: repoRoot, env: childEnvironment(home), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8'); child.stdout?.on('data', text => { output += String(text); });
  child.stderr?.setEncoding('utf8'); child.stderr?.on('data', text => { output += String(text); });
  return { child, output: () => `${output}\n(data dir: ${dataDir})` };
}

async function waitForReady(service: ServiceProcess, dataDir: string): Promise<ReturnType<typeof readServiceInfo> & object> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null || service.child.signalCode !== null)
      throw new Error(`the fixture service exited before readiness\n${service.output()}`);
    const info = readServiceInfo(dataDir);
    if (info && info.pid === service.child.pid) return info;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`the fixture service did not publish identity within 60s\n${service.output()}`);
}

async function stopService(service: ServiceProcess): Promise<void> {
  const exited = new Promise<number | null>(resolve => service.child.once('exit', code => resolve(code)));
  service.child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 60_000))]);
  if (code === null) {
    service.child.kill('SIGKILL');
    await exited;
    throw new Error(`the fixture service did not drain within 60s\n${service.output()}`);
  }
  assert.equal(code, 0, `the fixture service drained cleanly\n${service.output()}`);
}

/** Everything the brief names as preserved, read straight from the store on disk. */
function durableState(dataDir: string) {
  const store = new Store(join(dataDir, 'queue.sqlite'));
  try {
    return {
      taskRows: store.db.prepare('SELECT id, data FROM tasks ORDER BY id').all().map(row => ({ id: String(row.id), data: String(row.data) })),
      runRows: store.db.prepare('SELECT id, taskId, data FROM runs ORDER BY id').all().map(row => ({ id: String(row.id), taskId: String(row.taskId), data: String(row.data) })),
      eventRows: store.db.prepare('SELECT taskId, at, kind, detail FROM events ORDER BY taskId, at, kind').all().map(row => ({ ...row })),
      credentials: store.db.prepare('SELECT run, hash FROM credentials ORDER BY run').all().map(row => ({ ...row })),
      profiles: store.profiles(),
      pool: store.pool(),
      paused: store.getMeta<boolean>('paused'),
      capacity: Object.fromEntries(Object.keys(CAPACITY).map(key => [key, store.getMeta<number>(key)])),
      settings: readFileSync(join(dataDir, 'settings.json'), 'utf8'),
      runners: readFileSync(join(dataDir, 'runners.json'), 'utf8'),
    };
  } finally {
    store.close();
  }
}

async function liveView(dataDir: string) {
  const info = readServiceInfo(dataDir);
  assert.ok(info, 'the running service published its identity inside ~/.nucleus');
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  try {
    const state = await client.request('queue.snapshot', {}) as Record<string, unknown> & { tasks?: Array<{ id: string }> };
    const profiles = await client.request('profile.list', {}) as { profiles?: Array<{ id: string }> } | Array<{ id: string }>;
    const listed = Array.isArray(profiles) ? profiles : profiles.profiles ?? [];
    return {
      paused: state.paused,
      limits: {
        globalLimit: state.globalLimit, projectLimit: state.projectLimit, papercutProjectLimit: state.papercutProjectLimit,
        paseoCallLimit: state.paseoCallLimit, stallThresholdMinutes: state.stallThresholdMinutes,
        holdReminderMinutes: state.holdReminderMinutes, holdEscalationMinutes: state.holdEscalationMinutes,
        laneDrainMinutes: state.laneDrainMinutes, laneDrainEscalationMinutes: state.laneDrainEscalationMinutes,
      },
      taskIds: (state.tasks ?? []).map(task => task.id).sort(),
      profileIds: listed.map(profile => profile.id).sort(),
    };
  } finally {
    await client.close();
  }
}

test('the live leftover layout survives two service restarts through the post-move resolver', async t => {
  const root = socketFixtureDirectory(join('home', '.nucleus', 'queue-service.sock'));
  const started: ChildProcess[] = [];
  t.after(() => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const paseoHome = join(home, '.paseo');
  const dataDir = join(home, '.nucleus');
  const sealed = join(paseoHome, 'northstar-queue');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(sealed, { recursive: true, mode: 0o700 });

  writeFileSync(join(paseoHome, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: repoRoot } } }), { mode: 0o600 });
  writeFileSync(join(sealed, '.nucleus-redirect.json'), JSON.stringify({ to: dataDir }), { mode: 0o600 });
  writeFileSync(join(home, '.nucleus-stage-journal.json'), JSON.stringify({
    version: 1, cutover: true, phase: 'published', source: sealed, destination: dataDir,
  }));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ daemonUrl: 'ws://127.0.0.1:6767/ws', password: '', uncertainMergeRetryMs: 120_000 }));
  writeFileSync(join(dataDir, 'runners.json'), JSON.stringify([{ id: 'fixture-runner', entry: 'fixture', digest: 'c'.repeat(64), pinnedAt: '2026-01-01T00:00:00.000Z' }]));

  // Seed the store at ~/.nucleus, as the live machine holds it after the move.
  const seeding = new Store(join(dataDir, 'queue.sqlite'));
  let taskId: string;
  try {
    seeding.setMeta('paused', true);
    for (const [key, value] of Object.entries(CAPACITY)) seeding.setMeta(key, value);
    seeding.setProfiles(PROFILES.map(profile => nucleusProfileSchema.parse(profile)));
    seeding.setMeta('pool', POOL);
    const task = seeding.insert(submissionSchema.parse({
      submissionId: 'old-store-task', title: 'Recorded before the move', repoPath: '/fixture/repo',
      planningCommit: base, handoffPath: 'docs/handoffs/old-store.md', originAgentId: 'origin',
    }), 'fixture-host', 'handoff', base);
    taskId = task.id;
    seeding.putRun(runSchema.parse({
      id: 'old-store-review', taskId, role: 'reviewer', generation: 1,
      head: 'c'.repeat(40), base, agentId: 'fixture-reviewer-agent', workspaceId: 'fixture-workspace',
      profile: { id: 'fixture-reviewer', name: 'Fixture reviewer', provider: 'fixture', model: 'fixture/reviewer', notes: '', available: true, problem: '', supportedThinking: [] },
      status: 'finished', createdAt: '2026-01-01T00:00:00.000Z', lastObservedAt: null, active: false,
      idleSince: null, completion: null, released: true,
    }));
    seeding.setCredential('old-store-review', 'd'.repeat(64));
    seeding.db.prepare('INSERT INTO events(taskId, at, kind, detail) VALUES(?,?,?,?)')
      .run(taskId, '2026-01-01T00:00:00.000Z', 'recorded_before_move', JSON.stringify({ kept: true }));
  } finally {
    seeding.close();
  }

  const resolver = resolveDataHome(childEnvironment(home));
  assert.deepEqual(
    { root: resolver.root, source: resolver.source },
    { root: dataDir, source: 'store' },
    'with no override the resolver itself finds ~/.nucleus and ignores the leftover journal',
  );
  const before = durableState(dataDir);
  assert.equal(before.paused, true, 'the seeded store is paused');
  assert.equal(before.taskRows.length, 1);
  assert.equal(before.runRows.length, 1);

  // First start: the service opens the old store and reports its own view of it.
  const first = startService(home, dataDir);
  started.push(first.child);
  const firstInfo = await waitForReady(first, dataDir);
  assert.equal(readServiceInfo(dataDir)?.pid, first.child.pid);
  assert.equal(firstInfo.buildId.length >= 8, true);
  const firstView = await liveView(dataDir);
  assert.deepEqual(firstView, {
    paused: true, limits: { ...CAPACITY }, taskIds: [taskId], profileIds: ['fixture-reviewer', 'fixture-worker'],
  }, 'the first start sees the seeded pause, limits, task and profiles');
  await stopService(first);
  assert.equal(existsSync(serviceInfoPath(dataDir)), false, 'a drained service removes its own identity file');

  // Restart: same store, same records, same settings.
  // The reviewer reads this line as the observed result: what ran, where it opened,
  // and what each restart saw.
  t.diagnostic(`resolver: root=${resolver.root} source=${resolver.source}`);
  t.diagnostic(`first start: pid=${firstInfo.pid} view=${JSON.stringify(firstView)}`);

  const second = startService(home, dataDir);
  started.push(second.child);
  const secondInfo = await waitForReady(second, dataDir);
  assert.notEqual(secondInfo.pid, firstInfo.pid, 'the restart is a new process');
  assert.equal(secondInfo.socketPath, firstInfo.socketPath, 'and binds the same socket inside ~/.nucleus');
  const secondView = await liveView(dataDir);
  assert.deepEqual(secondView, firstView, 'the restarted service reports the same pause, limits, task and profiles');
  await stopService(second);

  const after = durableState(dataDir);
  assert.deepEqual(after, before, 'every record and setting is unchanged by the two restarts');  assert.equal(after.profiles.length, 2);
  assert.equal(after.pool.length, 2, 'both subscription entries survive');
  assert.deepEqual(after.capacity, { ...CAPACITY }, 'all nine limits survive');
  assert.equal(after.paused, true, 'the pause state survives');
  assert.equal(after.settings, before.settings);
  assert.equal(after.runners, before.runners);
  assert.deepEqual(after.taskRows, before.taskRows, 'the task row is byte-identical');
  assert.deepEqual(after.runRows, before.runRows, 'the reviewer run row is byte-identical');
  assert.deepEqual(after.eventRows, before.eventRows, 'the recorded event is byte-identical');
  assert.deepEqual(after.credentials, before.credentials, 'the callback credential hash is unchanged');
  // The store really is the one the inventory calls durable, at the folder the
  // resolver chose: nothing was copied or recreated beside it.
  for (const entry of DATA_HOME_ENTRIES.filter(item => item.path === 'queue.sqlite')) assert.equal(entry.kind, 'durable');
  assert.equal(existsSync(join(sealed, '.nucleus-redirect.json')), true, 'the sealed old view is left in place');
  assert.equal(existsSync(join(home, '.nucleus-stage-journal.json')), true, 'the leftover journal is left in place');
  assert.equal(realpathSync(dataDir), realpathSync(join(home, '.nucleus')));
  t.diagnostic(`second start: pid=${secondInfo.pid} view=${JSON.stringify(secondView)}`);
  t.diagnostic(`preserved: tasks=${after.taskRows.length} runs=${after.runRows.length} events=${after.eventRows.length} credentials=${after.credentials.length} profiles=${after.profiles.length} subscriptions=${after.pool.length} paused=${String(after.paused)} limits=${JSON.stringify(after.capacity)}`);
});
