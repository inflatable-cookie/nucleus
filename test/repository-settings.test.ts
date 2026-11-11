import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {chmodSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capacitySchema, DEFAULT_PASEO_CALL_LIMIT, DEFAULT_PROCESS_TERMINATION_GRACE_MS, DEFAULT_REPOSITORY_CHECKS_POLICY, projectDispatchLimitSchema, projectValidationSchema, repositoryChecksPolicySchema, repositorySetInputSchema, repositorySettingsSchema, VALIDATION_TIMEOUT_MAX_MS} from '../shared/contracts';
import {CURRENT_SCHEMA,Store} from '../core/store/store';
import {QueueRuntime} from '../service/runtime-owner';
import {command, git} from '../core/git/index';

test('project rows round-trip through set, get and list with outcome-style repository identity', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-projects-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  await command('git', ['clone', join(root, 'origin.git'), join(root, 'repo')], root);
  const repo = join(root, 'repo');
  await git(repo, 'remote', 'set-url', 'origin', 'https://github.com/ACME/App.git');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-projects-store-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    const row = await runtime.setRepository({repository: repo, closeout: 'agent', note: 'keeps its closeout records'});
    assert.deepEqual(row, repositorySettingsSchema.parse({
      repository: {origin: 'acme/app', path: repo},
      closeout: 'agent', note: 'keeps its closeout records', updatedAt: row.updatedAt, revision: row.revision,
    }));
    // The same row answers by local path and by normalised origin, the identity
    // shape outcomes and lanes already use.
    assert.equal((await runtime.getRepository({repository: repo}))?.closeout, 'agent');
    assert.equal((await runtime.getRepository({repository: 'acme/app'}))?.repository.path, repo);
    assert.equal(runtime.listRepositories().length, 1);

    const validation = {argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 30000, maxOutputBytes: 65536};
    const configured = await runtime.setRepository({repository: repo, closeout: 'agent', validation, note: 'validate'});
    const normalizedValidation = projectValidationSchema.parse(validation);
    assert.deepEqual(configured.validation, normalizedValidation);
    assert.deepEqual((await runtime.getRepository({repository: 'acme/app'}))?.validation, normalizedValidation);

    // Set patches the named fields: null clears an override, absent keeps it.
    const kept = await runtime.setRepository({repository: 'acme/app', closeout: null, note: ''});
    assert.deepEqual(kept.validation, normalizedValidation);
    const cleared = await runtime.setRepository({repository: 'acme/app', closeout: null, validation: null, note: ''});
    assert.equal(cleared.closeout, null);
    assert.equal(cleared.validation, null);
    assert.equal(cleared.note, '');
    assert.equal((await runtime.getRepository({repository: repo}))?.updatedAt, cleared.updatedAt);

    const scratch = await runtime.setRepository({repository: 'acme/app', scratchNamespace: 'effigy'});
    assert.equal(scratch.scratchNamespace, 'effigy');
    assert.equal(runtime.store.scratchNamespaceFor({repoPath: repo, repository: 'acme/app'}), 'effigy');
    await runtime.setRepository({repository: 'acme/app', scratchNamespace: null});
    assert.equal(runtime.store.scratchNamespaceFor({repoPath: repo, repository: 'acme/app'}), 'app');

    // A second repository joins the table; rows are never purged.
    await runtime.setRepository({repository: 'other/repo', closeout: 'queue', note: 'explicitly queue'});
    assert.deepEqual(runtime.listRepositories().map(project => project.repository.origin), ['acme/app', 'other/repo']);
    assert.equal(runtime.listRepositories()[1].repository.path, '');
  } finally { await runtime.stop(); }

  // Project settings survive restart like outcomes do.
  const reopened = new QueueRuntime({dataDir: dir, timers: false});
  try {
    assert.equal((await reopened.getRepository({repository: 'acme/app'}))?.closeout, null);
    assert.equal((await reopened.getRepository({repository: 'other/repo'}))?.closeout, 'queue');
  } finally { await reopened.stop(); }
});

test('setRepository refuses a non-origin string and a missing checkout path', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-projects-refuse-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    await assert.rejects(runtime.setRepository({repository: 'not an origin', closeout: null, note: ''}), /owner\/name/);
    await assert.rejects(runtime.setRepository({repository: join(dir, 'missing'), closeout: null, note: ''}), /does not exist/);
    assert.equal(runtime.listRepositories().length, 0);
  } finally { await runtime.stop(); }
});

test('a path-keyed row is re-keyed when the repository gains an origin, so a later override takes effect', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-projects-rekey-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await command('git', ['init', '--initial-branch=main', join(root, 'repo')], root);
  const repo = join(root, 'repo');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-projects-rekey-store-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    // Set while the checkout has no origin: the row keys by path.
    await runtime.setRepository({repository: repo, closeout: 'agent', note: 'old default'});
    assert.equal((await runtime.getRepository({repository: repo}))?.repository.origin, null);
    assert.equal(runtime.store.repositoryCloseoutOverride(repo), 'agent');

    // The repository gains an origin and the operator selects Queue again.
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/ACME/App.git');
    const updated = await runtime.setRepository({repository: repo, closeout: 'queue', note: ''});
    assert.equal(updated.closeout, 'queue');
    assert.deepEqual(runtime.listRepositories().map(project => project.repository), [{origin: 'acme/app', path: repo}], 'the stale path-keyed row is absorbed: one repository, one row');
    assert.equal((await runtime.getRepository({repository: repo}))?.closeout, 'queue');
    assert.equal(runtime.store.repositoryCloseoutOverride(repo, 'acme/app'), 'queue', 'the queue override takes effect once the origin is known');
    assert.equal(runtime.store.repositoryCloseoutOverride(repo), 'queue', 'a path-only read finds no agent shadow');
    // Clearing the override leaves the same single canonical row.
    await runtime.setRepository({repository: repo, closeout: null, note: ''});
    assert.deepEqual(runtime.listRepositories().map(project => project.repository), [{origin: 'acme/app', path: repo}]);
    assert.equal(runtime.store.repositoryCloseoutOverride(repo, 'acme/app'), null);
  } finally { await runtime.stop(); }
});

test('project.get by a reused checkout path answers with the canonical row closeout reads', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-projects-getpath-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await command('git', ['init', '--initial-branch=main', join(root, 'repo')], root);
  const repo = join(root, 'repo');
  await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/old.git');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-projects-getpath-store-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    await runtime.setRepository({repository: repo, closeout: 'agent', note: 'old project'});
    // The path is reused by a repository with a different origin.
    await git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/new.git');
    await runtime.setRepository({repository: repo, closeout: 'queue', note: 'new project'});
    // Closeout already reads the canonical row; a path-based get must answer
    // with the same row, never the old origin's setting.
    assert.equal(runtime.store.repositoryCloseoutOverride(repo, 'acme/new'), 'queue');
    const byPath = await runtime.getRepository({repository: repo});
    assert.equal(byPath?.repository.origin, 'acme/new');
    assert.equal(byPath?.closeout, 'queue');
    assert.equal(byPath?.note, 'new project');
    // Origin lookups keep answering with their exact rows.
    assert.equal((await runtime.getRepository({repository: 'acme/old'}))?.closeout, 'agent');
    assert.equal((await runtime.getRepository({repository: 'acme/new'}))?.closeout, 'queue');
    // With the origin unreadable the path hint applies, revision-ordered.
    await git(repo, 'remote', 'remove', 'origin');
    assert.equal((await runtime.getRepository({repository: repo}))?.closeout, 'queue');
  } finally { await runtime.stop(); }
});

test('a reused path never carries an old origin override to a different repository', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-projects-reuse-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    // The old project's row names origin and path; the path is later reused by a
    // repository with a different origin.
    store.putRepository({origin: 'acme/old', path: '/checkout'}, 'agent', 'old project');
    assert.equal(store.repositoryCloseoutOverride('/checkout', 'acme/old'), 'agent');
    assert.equal(store.repositoryCloseoutOverride('/checkout', 'acme/new'), null, 'known differing origins never match by path hint');

    // Setting the new project must not absorb the old project's permanent row.
    store.putRepository({origin: 'acme/new', path: '/checkout'}, 'queue', 'new project');
    assert.equal(store.repositories().length, 2, 'both repositories keep their rows');
    assert.equal(store.repositoryCloseoutOverride('/checkout', 'acme/new'), 'queue');
    assert.equal(store.repositoryCloseoutOverride('/checkout', 'acme/old'), 'agent', 'the old project keeps its override');
    assert.ok(store.repositoryFor('acme/new')!.revision > store.repositoryFor('acme/old')!.revision, 'each write gets a strictly higher monotonic revision');

    // With the checkout's origin unreadable the path hint applies, ordered by the
    // monotonic write revision: even identical timestamps cannot revive the older
    // setting.
    store.db.prepare("UPDATE repository_settings SET data=json_set(data,'$.updatedAt',?)").run(new Date(0).toISOString());
    assert.equal(store.repositoryCloseoutOverride('/checkout'), 'queue');
    store.putRepository({origin: 'acme/old', path: '/checkout'}, 'agent', 'old project touched');
    assert.equal(store.repositories().length, 2, 'an origin-bearing row is never absorbed');
    assert.equal(store.repositoryCloseoutOverride('/checkout'), 'agent');
  } finally { store.close(); }
});

test('the closeout override reads the canonical row even in a store that holds duplicate rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-projects-dup-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    // Simulate a store written before re-keying: the stale path-keyed agent row
    // sits first, the origin-keyed queue row second.
    store.putRepository({origin: null, path: '/checkout'}, 'agent', 'stale');
    store.db.prepare("INSERT INTO repository_settings(key,data) VALUES('acme/app',?)").run(JSON.stringify(repositorySettingsSchema.parse({
      repository: {origin: 'acme/app', path: '/checkout'}, closeout: 'queue', note: '', updatedAt: new Date().toISOString(),
    })));
    assert.equal(store.repositoryCloseoutOverride('/checkout', 'acme/app'), 'queue', 'an origin identity match outranks the stale path row');
    assert.equal(store.repositories().length, 2, 'reads never rewrite; the next set absorbs the duplicate');
    store.putRepository({origin: 'acme/app', path: '/checkout'}, 'agent', 'touch');
    assert.equal(store.repositories().length, 1, 'the next write absorbs the stale row');
  } finally { store.close(); }
});

test('the closeout override matches by origin when the repository has one, else by exact path', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-projects-match-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    store.putRepository({origin: 'acme/app', path: ''}, 'agent', 'origin-only row');
    assert.equal(store.repositoryCloseoutOverride('/some/checkout', 'acme/app'), 'agent');
    assert.equal(store.repositoryCloseoutOverride('/some/checkout', 'other/repo'), null);
    assert.equal(store.repositoryCloseoutOverride('/some/checkout'), null, 'no origin and no path match');

    store.putRepository({origin: null, path: '/some/checkout'}, 'agent', 'path hint row');
    assert.equal(store.repositoryCloseoutOverride('/some/checkout'), 'agent');
    assert.equal(store.repositoryCloseoutOverride('/some/other'), null);

    assert.equal(store.repositoryFor('acme/app')?.note, 'origin-only row');
    assert.equal(store.repositoryFor('/some/checkout')?.note, 'path hint row');
    assert.equal(store.repositoryFor('unknown'), null);
  } finally { store.close(); }
});

test('a repository opts into formal reviews with a reviewer login, and null clears it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-reviewer-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    const row = await runtime.setRepository({repository: 'acme/app', closeout: null, reviewer: {login: 'northstar-reviewer'}, note: 'formal reviews'});
    assert.deepEqual(row.reviewer, {login: 'northstar-reviewer'});
    assert.deepEqual((await runtime.getRepository({repository: 'acme/app'}))?.reviewer, {login: 'northstar-reviewer'});
    // Omitting the reviewer keeps it; an explicit null clears the opt-in.
    assert.deepEqual((await runtime.setRepository({repository: 'acme/app', note: ''})).reviewer, {login: 'northstar-reviewer'});
    const cleared = await runtime.setRepository({repository: 'acme/app', reviewer: null});
    assert.equal(cleared.reviewer, null);
    // A bad login shape is refused before anything is stored.
    await assert.rejects(runtime.setRepository({repository: 'other/repo', closeout: null, reviewer: {login: 'not a login'}, note: ''}), /GitHub login/);
  } finally { await runtime.stop(); }
});

test('a validation timeout may run up to thirty minutes and no further', () => {
  const validation = (timeoutMs: number) => ({argv: ['effigy', 'ci:fresh'], timeoutMs, maxOutputBytes: 65536});
  assert.equal(VALIDATION_TIMEOUT_MAX_MS, 1_800_000);
  assert.equal(projectValidationSchema.parse(validation(1)).terminationGraceMs, DEFAULT_PROCESS_TERMINATION_GRACE_MS);
  // Project-K's fresh-checkout validation takes 604 s; the old ten-minute cap refused any bound that fits it.
  assert.equal(projectValidationSchema.safeParse(validation(1_200_000)).success, true);
  assert.equal(projectValidationSchema.safeParse(validation(VALIDATION_TIMEOUT_MAX_MS)).success, true);
  assert.equal(projectValidationSchema.safeParse(validation(VALIDATION_TIMEOUT_MAX_MS + 1)).success, false);
  assert.equal(projectValidationSchema.safeParse({ ...validation(1), terminationGraceMs: 300_001 }).success, false);
});

test('Settings-only capacity writes apply and record the change, refuse every other surface and preserve every other setting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-capacity-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  const capacityState = () => runtime.capacityAuthorityState();
  const values = {
    globalLimit: 20, projectLimit: 4, papercutProjectLimit: 3, paseoCallLimit: 12,
    stallThresholdMinutes: 50, holdReminderMinutes: 90, holdEscalationMinutes: 180,
    laneDrainMinutes: 45, laneDrainEscalationMinutes: 90,
  };
  try {
    assert.equal(runtime.store.configuredPaseoCallLimit(), DEFAULT_PASEO_CALL_LIMIT, 'the default is sized to Paseo interactive capacity');
    assert.equal(runtime.admission.totalLimit, DEFAULT_PASEO_CALL_LIMIT);
    // Every setting the change does not own, written before the capacity write.
    const project = runtime.store.ensureProject('/fixture/project-a', 'owner/project-a');
    await runtime.configureProjectDispatchLimit({ projectKey: project.key, limit: 64 });
    assert.equal(runtime.store.projectInFlightLimitFor({ repoPath: '/fixture/project-a', repository: 'owner/project-a' }), 128, 'the in-flight cap is always twice the project slot limit');
    assert.throws(() => projectDispatchLimitSchema.parse({ projectKey: project.key, inFlightLimit: 8 }), 'the RPC has no in-flight field');
    runtime.queueControl({ paused: false });
    runtime.store.transaction(() => runtime.store.setMeta('pool', [{ profileId: 'fixture', group: 'subscription', weight: 2, enabled: true, scopes: ['general'], roles: ['worker'] }]));
    runtime.availabilityControl({ group: 'subscription', unavailable: true, reason: 'usage limit reached', retryAt: null });
    await runtime.configureUsage({ level: 'high', until: null });
    await runtime.configureDemandOffsets({ worker: 1, reviewer: -1, coordinator: 0 });
    runtime.store.setMeta('operationLimit', 77);
    const preserved = () => {
      const meta: Record<string, unknown> = {};
      for (const key of ['paused', 'pool', 'usageLevel', 'demandRoleOffsets', 'operationLimit', 'projectDispatchLimit', 'hostId']) meta[key] = runtime.store.getMeta(key);
      return { meta, availability: runtime.store.availability(), overrides: runtime.store.projectDispatchLimitOverrides(), paseo: runtime.store.configuredPaseoCallLimit(), operation: runtime.store.configuredOperationLimit(), revision: runtime.store.telemetryRevision() };
    };
    const before = preserved();
    const stateBefore = capacityState();
    assert.deepEqual(stateBefore.changes, [], 'no change is recorded yet, and no document is needed');

    // The Settings surface (the Paseo plugin bridge) applies the whole state.
    await runtime.configureCapacity(values, undefined, { via: 'paseo' });
    for (const [key, value] of Object.entries(values)) assert.equal(runtime.store.getMeta(key), value, key);
    assert.equal(runtime.admission.totalLimit, 12, 'the live Paseo-call bound reads the applied value without a restart');
    assert.equal(runtime.store.papercutDispatchPolicy().limit, 3);
    assert.equal(runtime.store.getMeta('paused'), false, 'pause is not a capacity key and is untouched');

    const recorded = capacityState();
    assert.deepEqual(recorded.effective, values);
    assert.equal(recorded.changes.length, 1);
    const change = recorded.changes[0]!;
    assert.equal(change.version, 1);
    assert.ok(!Number.isNaN(Date.parse(change.at)), `the record time parses: ${change.at}`);
    assert.equal(change.surface, 'paseo', 'the recorded surface is the transport surface');
    assert.deepEqual(change.before, stateBefore.effective, 'the record carries the state the change replaced');
    assert.deepEqual(change.after, recorded.effective, 'and the whole state it put in force');

    // Nothing outside the capacity keys moved.
    const after = preserved();
    assert.deepEqual(after.meta, before.meta);
    assert.deepEqual(after.availability, before.availability, 'subscriptions are not capacity and are untouched');
    assert.deepEqual(after.overrides, before.overrides);
    assert.equal(after.paseo, 12);
    assert.equal(after.operation, 77, 'the operation budget is not capacity and is untouched');

    // A second save of the values in force is a no-op: no record, no revision.
    const revision = runtime.store.telemetryRevision();
    await runtime.configureCapacity(values, undefined, { via: 'paseo' });
    assert.equal(capacityState().changes.length, 1, 'a no-op records nothing');
    assert.equal(runtime.store.telemetryRevision(), revision, 'a no-op advances no revision');

    // Parent falsification: the old route was an ordinary handler call. Without the
    // bridge surface it refuses and changes nothing, and an unknown surface is not
    // mistaken for it either.
    await assert.rejects(() => runtime.configureCapacity({ globalLimit: 24, projectLimit: 4 }), /queue\.capacity is refused/);
    await assert.rejects(() => runtime.configureCapacity({ globalLimit: 24, projectLimit: 4 }, undefined, { via: 'settings' }), /queue\.capacity is refused/);
    assert.equal(runtime.store.getMeta('globalLimit'), 20);
    assert.equal(capacityState().changes.length, 1);

    // A later Settings change records the whole before and after at the next version,
    // and an omitted field keeps the value in force.
    await runtime.configureCapacity({ globalLimit: 21, projectLimit: 4 }, undefined, { via: 'paseo' });
    const second = capacityState();
    assert.equal(second.changes.length, 2);
    assert.equal(second.changes[1]!.version, 2);
    assert.deepEqual(second.changes[1]!.before, change.after);
    assert.equal(second.changes[1]!.after.globalLimit, 21);
    assert.equal(second.changes[1]!.after.paseoCallLimit, 12, 'an omitted field keeps its value');

    // Bounds are the shared schema's; nothing is written outside them.
    for (const value of [1, 32]) assert.equal(capacitySchema.safeParse({globalLimit: 24, projectLimit: 4, paseoCallLimit: value}).success, true, String(value));
    for (const value of [0, 33]) assert.equal(capacitySchema.safeParse({globalLimit: 24, projectLimit: 4, paseoCallLimit: value}).success, false, String(value));
    for (const papercutProjectLimit of [1,32]) assert.equal(capacitySchema.safeParse({globalLimit:24,projectLimit:4,papercutProjectLimit}).success,true);
    for (const papercutProjectLimit of [0,33]) assert.equal(capacitySchema.safeParse({globalLimit:24,projectLimit:4,papercutProjectLimit}).success,false);
    for (const limit of [0, 1, 64]) assert.equal(projectDispatchLimitSchema.safeParse({ projectKey: project.key, limit }).success, true, String(limit));
    for (const limit of [-1, 65]) assert.equal(projectDispatchLimitSchema.safeParse({ projectKey: project.key, limit }).success, false, String(limit));
  } finally { await runtime.stop(); }
});

test('a store still carrying the retired applied capacity record keeps the Settings change and is never re-asserted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-capacity-retired-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  // The #426 shape a host might still carry: an applied version with its digest,
  // capacity and facts, and a projection those were re-asserted from.
  const retired = {
    version: 3, at: '2026-10-25T08:00:00.000Z', digest: 'a'.repeat(64),
    capacity: { globalLimit: 9, projectLimit: 2, papercutProjectLimit: 2, paseoCallLimit: 6,
      stallThresholdMinutes: 30, holdReminderMinutes: 120, holdEscalationMinutes: 240,
      laneDrainMinutes: 120, laneDrainEscalationMinutes: 1440 },
  };
  let retiredFact: unknown;
  try {
    runtime.store.transaction(() => {
      runtime.store.setMeta('capacityAuthorityApplied', retired);
      runtime.store.setMeta('globalLimit', 9);
    });
    // A Settings change applies over it and is not overwritten by the retired record.
    await runtime.configureCapacity({ globalLimit: 21, projectLimit: 4 }, undefined, { via: 'paseo' });
    assert.equal(runtime.store.getMeta('globalLimit'), 21);
    assert.equal(runtime.store.getMeta('projectLimit'), 4);
    retiredFact = runtime.store.getMeta('capacityAuthorityApplied');
    // Reads and health passes never restore the retired projection.
    assert.equal(runtime.health().capacityAuthority?.changes, 1);
    runtime.capacityAuthorityState();
    assert.equal(runtime.store.getMeta('globalLimit'), 21);
    assert.deepEqual(runtime.store.getMeta('capacityAuthorityApplied'), retiredFact, 'the historical record is left exactly as it was');
  } finally { await runtime.stop(); }
  // A restart applies nothing either: the Settings values and the record stand.
  const restarted = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    assert.equal(restarted.store.getMeta('globalLimit'), 21, 'startup never re-asserts the retired record');
    assert.equal(restarted.capacityAuthorityState().changes.length, 1);
  } finally { await restarted.stop(); }
});

test('repository.set patches named fields: absent keeps, null clears, a full payload replaces', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-patch-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    const qa = {argv: ['effigy', 'qa'], timeoutMs: 60000, maxOutputBytes: 4096};
    await runtime.setRepository({repository: 'acme/patch', closeout: 'agent', reviewer: {login: 'inflatable-tester'}, note: 'n'});
    const withQa = await runtime.setRepository({repository: 'acme/patch', qa});
    assert.equal(withQa.reviewer?.login, 'inflatable-tester');
    assert.equal(withQa.closeout, 'agent');
    assert.equal(withQa.note, 'n');
    assert.deepEqual(withQa.qa?.argv, qa.argv);
    const noReviewer = await runtime.setRepository({repository: 'acme/patch', reviewer: null});
    assert.equal(noReviewer.reviewer, null);
    assert.deepEqual(noReviewer.qa, withQa.qa);
    const full = await runtime.setRepository({repository: 'acme/patch', closeout: 'queue', validation: null, reviewer: {login: 'x'}, qa: null, note: 'all'});
    assert.equal(full.closeout, 'queue');
    assert.equal(full.reviewer?.login, 'x');
    assert.equal(full.qa, null);
    assert.equal(full.note, 'all');
  } finally {
    await runtime.stop();
  }
});

test('the retired per-repository validation policy is refused by name and stored copies are dropped', t => {
  // Task 985 (Tom, 2026-11-09): the repository's AGENTS.md Validate section is the
  // only source. A stored row from an older build loses its copy on open, and
  // `repository.set` refuses the field with the replacement named instead of a
  // generic unrecognized-key error.
  const dir = mkdtempSync(join(tmpdir(), 'nsq-retired-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  store.putRepository({ origin: 'acme/legacy', path: '/repos/legacy' }, null, '');
  // Write the retired field the way an older build stored it.
  store.db.exec(`UPDATE repository_settings SET data=json_set(data,'$.validationPolicy','Run lint only.') WHERE key='acme/legacy'`);
  store.setMeta('defaultValidationPolicy', JSON.stringify('Run compile only.'));
  store.close();
  store = new Store(path);
  try {
    const row = store.repositoryFor('acme/legacy');
    assert.equal('validationPolicy' in (row ?? {}), false, 'the stored copy is dropped on open and the row parses');
    assert.equal(store.getMeta('defaultValidationPolicy'), undefined, 'the retired default is gone');
    const refused = repositorySetInputSchema.safeParse({ repository: 'acme/legacy', validationPolicy: 'Compile only' });
    assert.equal(refused.success, false, 'repository.set with the retired field is refused');
    if (!refused.success) {
      assert.match(refused.error.issues[0]?.message ?? '', /validationPolicy is no longer available/);
      assert.match(refused.error.issues[0]?.message ?? '', /AGENTS\.md Validate section/);
    }
    const settings = repositorySettingsSchema.safeParse({ repository: { origin: 'acme/x', path: '' }, updatedAt: new Date().toISOString(), validationPolicy: 'kept out' });
    assert.equal(settings.success, false, 'no settings row keeps the field');
  } finally { store.close(); }
});


test('the hosted-check policy defaults to blocking, round-trips, survives reload and never leaks across origins', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-checks-policy-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  // Activation reads GitHub's requirement surface; these fixtures answer readably.
  const transport = async (_t: unknown, endpoint: string) => {
    if (endpoint === 'repos/acme/app') return {full_name: 'acme/app', default_branch: 'main'};
    if (endpoint.endsWith('/protection/required_status_checks')) return {strict: false, contexts: [], checks: []};
    if (endpoint.includes('/rules/branches/')) return [[]];
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  let runtime = new QueueRuntime({dataDir: dir, timers: false, requiredCheckTransport: transport});
  const unset = await runtime.setRepository({repository: 'acme/app', closeout: 'agent', note: 'before'});
  try {
    assert.equal(unset.checksPolicy, null, 'an existing repository stores no policy and keeps blocking');
    assert.equal(runtime.store.checksPolicyFor({repoPath: '/checkouts/app', repository: 'acme/app'}), DEFAULT_REPOSITORY_CHECKS_POLICY);
    assert.equal(DEFAULT_REPOSITORY_CHECKS_POLICY, 'all');

    const advisory = await runtime.setRepository({repository: 'acme/app', checksPolicy: 'required'});
    assert.equal(advisory.checksPolicy, 'required');
    assert.equal(advisory.validation, null);
    assert.equal(advisory.qa, null);
    assert.equal(advisory.closeout, 'agent', 'an unrelated setting is untouched');
    assert.equal(advisory.note, 'before');
    assert.equal(runtime.store.checksPolicyFor({repoPath: '/checkouts/app', repository: 'acme/app'}), 'required');
    // A same-named local path carries no other origin's policy: origin identity outranks it.
    assert.equal(runtime.store.checksPolicyFor({repoPath: '/checkouts/app', repository: 'acme/other'}), 'all');
    // An unrelated patch keeps the policy; an explicit null restores the default.
    const noted = await runtime.setRepository({repository: 'acme/app', note: 'after'});
    assert.equal(noted.checksPolicy, 'required');
    assert.equal(noted.revision > advisory.revision, true);
    assert.equal(repositoryChecksPolicySchema.safeParse('required').success, true);
    assert.equal(repositoryChecksPolicySchema.safeParse('advisory').success, false, 'one documented schema, not a parallel knob');
  } finally { await runtime.stop(); }

  runtime = new QueueRuntime({dataDir: dir, timers: false});
  try {
    assert.equal((await runtime.getRepository({repository: 'acme/app'}))?.checksPolicy, 'required', 'the policy survives reload and recovery');
    assert.equal(runtime.store.checksPolicyFor({repoPath: '/checkouts/app', repository: 'acme/app'}), 'required');
    assert.equal((await runtime.setRepository({repository: 'acme/app', checksPolicy: null})).checksPolicy, null);
    assert.equal(runtime.store.checksPolicyFor({repoPath: '/checkouts/app', repository: 'acme/app'}), 'all');
  } finally { await runtime.stop(); }
});

test('a path-only settings row keeps its hosted-check policy through a later origin-only write and never outranks origin identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-checks-policy-paths-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    store.putRepository({origin: null, path: '/checkouts/reused'}, null, 'path only');
    const saved = store.patchRepository({origin: null, path: '/checkouts/reused'}, {checksPolicy: 'required'});
    assert.equal(saved.checksPolicy, 'required');
    assert.equal(store.checksPolicyFor({repoPath: '/checkouts/reused', repository: null}), 'required');
    // A putRepository that does not name a policy (a note change) preserves it.
    store.putRepository({origin: null, path: '/checkouts/reused'}, null, 'note changed');
    assert.equal(store.repositoryFor('/checkouts/reused')?.checksPolicy, 'required');
    // An origin appearing later re-keys the row and keeps the policy.
    store.putRepository({origin: 'acme/reused', path: '/checkouts/reused'}, null, 'origin added');
    assert.equal(store.repositoryFor('acme/reused')?.checksPolicy, 'required');
    assert.equal(store.checksPolicyFor({repoPath: '/checkouts/reused', repository: 'acme/reused'}), 'required');
    // A different known origin at the same path never inherits it.
    assert.equal(store.checksPolicyFor({repoPath: '/checkouts/reused', repository: 'acme/elsewhere'}), 'all');
  } finally { store.close(); }
});

test('an unsupported required-check capability refuses setup before any field of the patch commits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-checks-policy-unsupported-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const calls: string[] = [];
  const planLimited = Object.assign(new Error('Command failed: gh api'), {stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'});
  const runtime = new QueueRuntime({dataDir: dir, timers: false, requiredCheckTransport: async (_t, endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'repos/acme/app') return {full_name: 'acme/app', default_branch: 'main', private: true};
    throw planLimited;
  }});
  try {
    const before = await runtime.setRepository({repository: 'acme/app', closeout: 'agent', note: 'before'});
    calls.length = 0;
    await assert.rejects(
      runtime.setRepository({repository: 'acme/app', checksPolicy: 'required', closeout: 'queue', note: 'after'}),
      /plan or visibility[\s\S]*Make the repository public or upgrade its plan, or keep the default "all" policy[\s\S]*Nothing was written/);
    // Multi-field refusal is atomic: no field of the patch, and no revision, was written.
    assert.deepEqual(await runtime.getRepository({repository: 'acme/app'}), before);
    assert.equal((await runtime.getRepository({repository: 'acme/app'}))?.closeout, 'agent');
    assert.equal((await runtime.getRepository({repository: 'acme/app'}))?.checksPolicy, null);
    assert.equal(calls.filter(call => call.includes('/protection/required_status_checks')).length, 1, 'the refusal names the surface GitHub refused');
    // Switching to all and unsetting stay available without the failed capability.
    calls.length = 0;
    assert.equal((await runtime.setRepository({repository: 'acme/app', checksPolicy: 'all'})).checksPolicy, 'all');
    assert.equal((await runtime.setRepository({repository: 'acme/app', checksPolicy: null})).checksPolicy, null);
    // Ordinary settings patches are untouched and never read GitHub.
    assert.equal((await runtime.setRepository({repository: 'acme/app', note: 'plain'})).note, 'plain');
    assert.deepEqual(calls, [], 'only an explicit required activation reads the capability');
  } finally { await runtime.stop(); }
});

test('a supported required-check surface permits activation, is re-read on every activation and is never stored as proof', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-checks-policy-supported-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const calls: string[] = [];
  const runtime = new QueueRuntime({dataDir: dir, timers: false, requiredCheckTransport: async (_t, endpoint, args) => {
    calls.push(`${endpoint}${args ? ` ${args.join(' ')}` : ''}`);
    if (endpoint === 'repos/acme/rules') return {full_name: 'acme/rules', default_branch: 'trunk'};
    if (endpoint.endsWith('/protection/required_status_checks')) return {strict: true, contexts: ['build'], checks: [{context: 'build', app_id: 15368}]};
    if (endpoint.includes('/rules/branches/')) return [[{type: 'required_status_checks', parameters: {required_status_checks: [{context: 'qa', integration_id: 7}]}}]];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }});
  try {
    const saved = await runtime.setRepository({repository: 'acme/rules', checksPolicy: 'required', note: 'advisory checks'});
    assert.equal(saved.checksPolicy, 'required');
    // The canonical repository's own default branch was read; main was never assumed.
    assert.deepEqual(calls, [
      'repos/acme/rules',
      'repos/acme/rules/branches/trunk/protection/required_status_checks',
      'repos/acme/rules/rules/branches/trunk?per_page=100 --paginate --slurp',
    ]);
    assert.equal(calls.some(call => /\/main/.test(call)), false, 'no branch is guessed');
    // The settings row carries the documented fields only: the capability is not proof.
    assert.deepEqual(Object.keys(saved).sort(), ['checksPolicy', 'closeout', 'note', 'qa', 'repository', 'reviewer', 'revision', 'scratchNamespace', 'updatedAt', 'validation']);
    // A second explicit activation observes again instead of relying on the first answer.
    calls.length = 0;
    await runtime.setRepository({repository: 'acme/rules', checksPolicy: 'all'});
    await runtime.setRepository({repository: 'acme/rules', checksPolicy: 'required'});
    assert.equal(calls.filter(call => call === 'repos/acme/rules').length, 1);
  } finally { await runtime.stop(); }
});

test('a settings write during the required-check capability read refuses and never overwrites the newer row', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-checks-policy-concurrent-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const runtime = new QueueRuntime({dataDir: dir, timers: false, requiredCheckTransport: async (_t, endpoint) => {
    if (endpoint === 'repos/acme/app') return {full_name: 'acme/app', default_branch: 'main'};
    if (endpoint.endsWith('/protection/required_status_checks')) { held = true; await gate; return {strict: false, contexts: [], checks: []}; }
    return [[]];
  }});
  try {
    await runtime.setRepository({repository: 'acme/app', note: 'before'});
    const activation = runtime.setRepository({repository: 'acme/app', checksPolicy: 'required', note: 'stale'});
    for (let attempt = 0; attempt < 100 && !held; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(held, true, 'the capability read is in flight');
    const newer = await runtime.setRepository({repository: 'acme/app', note: 'newer'});
    assert.equal(newer.note, 'newer');
    release();
    await assert.rejects(activation, /changed while the required-check capability was observed \(revision \d+ to \d+\)[\s\S]*Nothing was written/);
    const after = await runtime.getRepository({repository: 'acme/app'});
    assert.equal(after?.note, 'newer', 'the newer settings write survives');
    assert.equal(after?.checksPolicy, null, 'the stale activation wrote no policy');
    assert.equal(after?.revision, newer.revision);
  } finally { await runtime.stop(); }
});

test('a checkout whose origin disagrees with its recorded settings refuses required activation and writes nothing', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-checks-policy-identity-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const checkout = join(root, 'checkout');
  await command('git', ['init', '--initial-branch=main', checkout], root);
  await git(checkout, 'remote', 'add', 'origin', 'https://github.com/acme/new.git');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-checks-policy-identity-store-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const calls: string[] = [];
  const runtime = new QueueRuntime({dataDir: dir, timers: false, requiredCheckTransport: async (_t, endpoint) => {
    calls.push(endpoint);
    return {full_name: 'acme/new', default_branch: 'main'};
  }});
  try {
    // The permanent row names another origin at this reused checkout path.
    runtime.store.putRepository({origin: 'acme/old', path: checkout}, 'agent', 'recorded old origin');
    const before = runtime.store.repositoryFor('acme/old');
    await assert.rejects(
      runtime.setRepository({repository: checkout, checksPolicy: 'required', note: 'moved'}),
      /record origin acme\/old, but that checkout now reports acme\/new[\s\S]*Nothing was written/);
    assert.deepEqual(runtime.store.repositoryFor('acme/old'), before);
    assert.equal(runtime.store.repositoryFor('acme/new'), null, 'no row was written under the other origin');
    assert.deepEqual(calls, [], 'a mismatched identity is refused before any forge read');
  } finally { await runtime.stop(); }
});
