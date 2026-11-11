import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { independentReviewRoutingConflict, type RoutingPreflightInput } from '../core/dispatch/routing';
import { QueueRuntime } from '../service/runtime-owner';
import { git } from '../core/git/index';
import { briefDigest } from '../core/planning/brief';
import { prepareHandoff } from '../core/planning/handoff';
import { poolSchema, type PoolEntry, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';


const entry = (profileId: string, roles: PoolEntry['roles'], over: Partial<PoolEntry> = {}) =>
  poolSchema.parse({ profileId, enabled: true, group: profileId, roles, weight: 1, scopes: ['general'], ...over });
const luna = profile('luna', 'gpt-6-luna');
const lunaReviewer = profile('luna-reviewer', 'gpt-6-luna');
const sol = profile('sol', 'gpt-6.1-sol');
const muse = profile('muse', 'muse-1.5');
const opaque = profile('opaque', 'provider/default');
const profiles = [luna, lunaReviewer, sol, muse, opaque];
const pool = [
  entry('luna', ['worker', 'reviewer']),
  entry('luna-reviewer', ['reviewer']),
  entry('sol', ['worker', 'reviewer']),
  entry('muse', ['worker', 'reviewer']),
  entry('opaque', ['worker', 'reviewer']),
];
const required = (profileId: string) => ({ profileId, reason: 'Need this model', required: true as const });
const optional = (profileId: string) => ({ profileId, reason: 'Prefer this model', required: false as const });
const routing = (over: Partial<RoutingPreflightInput> = {}): RoutingPreflightInput =>
  ({ scope: 'general', ...over });
const conflict = (over: Partial<RoutingPreflightInput> = {}, catalog = profiles, entries = pool) =>
  independentReviewRoutingConflict(routing(over), catalog, entries);

test('required same profile is refused with the conflicting roles and model', () => {
  const message = conflict({ profileRequests: { worker: required('luna'), reviewer: required('luna') } });
  assert.match(message ?? '', /Required worker luna \(gpt-6-luna\) and required reviewer luna \(gpt-6-luna\) share the same model/);
  assert.match(message ?? '', /choose independent worker and reviewer routing/);
  assert.doesNotMatch(message ?? '', /No eligible/);
});

test('distinct profile IDs that normalize to the same model are refused', () => {
  const message = conflict({ profileRequests: { worker: required('luna'), reviewer: required('luna-reviewer') } });
  assert.match(message ?? '', /required worker luna \(gpt-6-luna\) and required reviewer luna-reviewer \(gpt-6-luna\) share model gpt-6-luna/);
  assert.match(message ?? '', /choose independent/);
});

test('legacy required preference uses the same precedence as selection', () => {
  assert.match(
    conflict({ preferredProfileId: 'luna', requirePreferred: true, profileRequests: { reviewer: required('luna-reviewer') } }) ?? '',
    /required worker luna/,
  );
  assert.equal(
    conflict({ preferredProfileId: 'luna', requirePreferred: true, profileRequests: { worker: optional('sol'), reviewer: required('luna') } }),
    null,
    'a worker request takes precedence over preferredProfileId, so an optional Sol request is not a required Luna pairing',
  );
});

test('valid distinct models pass', () => {
  assert.equal(conflict({ profileRequests: { worker: required('luna'), reviewer: required('sol') } }), null);
});

test('optional request or fallback still passes when an independent catalog route exists', () => {
  assert.equal(conflict({ profileRequests: { worker: required('luna'), reviewer: optional('luna') } }), null);
  assert.equal(conflict({ preferredProfileId: 'luna', requirePreferred: true, profileRequests: { reviewer: optional('luna-reviewer') } }), null);
  assert.equal(conflict({ profileRequests: { worker: optional('luna'), reviewer: required('luna') } }), null);
});

test('optional same-model pair is refused only when every concrete reviewer route shares the author model', () => {
  const onlyLunaReviewers = [
    entry('luna', ['worker', 'reviewer']),
    entry('luna-reviewer', ['reviewer']),
    // Spec 053: every enabled profile can review, so the others are off.
    entry('sol', ['worker'], { enabled: false }),
    entry('muse', ['worker'], { enabled: false }),
    entry('opaque', ['worker']),
  ];
  const message = conflict({ profileRequests: { worker: required('luna'), reviewer: optional('luna') } }, profiles, onlyLunaReviewers);
  assert.match(message ?? '', /required worker luna \(gpt-6-luna\) leaves no independent reviewer route/);
  assert.match(message ?? '', /choose independent/);
});

test('an exhausted subscription is not treated as a permanent identity conflict', () => {
  const exhausted = [entry('sol', ['worker', 'reviewer'], { group: 'sol-exhausted' }), ...pool.filter(item => item.profileId !== 'sol')];
  assert.equal(conflict({ profileRequests: { worker: required('luna'), reviewer: optional('luna') } }, profiles, exhausted), null);
});

test('missing or opaque required identity fails closed with an honest refusal', () => {
  assert.match(conflict({ profileRequests: { worker: required('absent'), reviewer: required('sol') } }) ?? '', /Required worker profile absent is absent from the live catalog/);
  assert.match(conflict({ profileRequests: { worker: required('opaque'), reviewer: required('sol') } }) ?? '', /opaque provider-default model that cannot prove review independence/);
  assert.match(
    conflict({ declaredAuthorModels: ['provider/default'], profileRequests: { reviewer: required('sol') } }) ?? '',
    /Declared author model provider\/default is opaque/,
  );
  assert.equal(conflict({ profileRequests: { worker: optional('absent'), reviewer: required('sol') } }), null);
});

test('review entry preserves declared-author exclusion', () => {
  const message = conflict({ declaredAuthorModels: ['openai/gpt-6-luna'], profileRequests: { reviewer: required('luna') } });
  assert.match(message ?? '', /declared author model openai\/gpt-6-luna and required reviewer luna \(gpt-6-luna\) share model gpt-6-luna/);
  assert.equal(conflict({ declaredAuthorModels: ['openai/gpt-6-luna'], profileRequests: { reviewer: required('sol') } }), null);
  assert.equal(conflict({ declaredAuthorModels: ['openai/gpt-6-luna'] }), null, 'no reviewer request keeps eligibility for later selection');
});

test('skipPRReview and unspecified routing are not inferred as identity conflicts', () => {
  assert.equal(conflict({ skipPRReview: true, profileRequests: { worker: required('luna'), reviewer: required('luna') } }), null);
  assert.equal(conflict({}), null);
  assert.equal(conflict({ preferredProfileId: 'luna', requirePreferred: false }), null);
});

const brief = (queue: string) => `---
title: Routing preflight
queue:
  complexity: medium
${queue}
---

## Outcome

Prove the routing preflight.
`;

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-routing-preflight-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await git(root, 'init', '--bare', '--initial-branch=main', join(root, 'origin.git'));
  await git(root, 'clone', join(root, 'origin.git'), repo);
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  await mkdir(join(repo, '.paseo'), { recursive: true });
  await writeFile(join(repo, '.paseo', 'queue.json'), JSON.stringify({ schema: 'paseo.queue.control.v5', closeout: 'queue', hooks: [] }));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  await git(repo, 'push', 'origin', 'main');
  const adapter = {
    client: { isConnected: true }, hostId: 'fixture-host', socketPath: join(root, 'callback.sock'), helperPath: join(root, 'helper.mjs'),
    connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [{ key: "test", label: "test", available: true, problem: "", models: profiles.map(p => ({ id: p.model, label: p.model, aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] })) }] }),
    originAgent: async (id: string) => ({ id, workspaceId: 'origin-ws', archived: false }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: join(root, 'data'), adapterFactory: () => adapter, timers: false });
  t.after(() => runtime.drain());
  await runtime.started;
  await runtime.bootstrap;
  runtime.store.setProfiles(profiles.map(({ available, problem, supportedThinking, ...p }) => p));
  await runtime.engine.refresh();
  runtime.store.setMeta('paused', true);
  runtime.store.setMeta('pool', pool);
  runtime.engine.profiles = profiles;
  return { runtime, repo, root };
}

test('lead.check surfaces a required same-model pair before Ready and creates no task', async t => {
  const f = await fixture(t);
  const lead = await f.runtime.addLead({
    repositories: [{ origin: f.repo, path: f.repo }],
    title: 'Same-model pair',
    body: brief('  scope: general\n  profileRequests:\n    worker:\n      profileId: luna\n      reason: Luna implements\n      required: true\n    reviewer:\n      profileId: luna\n      reason: Luna reviews\n      required: true\n'),
    lanes: [],
    author: 'planner',
  });
  assert.equal(lead.check?.ok, false);
  assert.match(lead.check?.message ?? '', /Required worker luna \(gpt-6-luna\) and required reviewer luna \(gpt-6-luna\) share the same model/);
  assert.match(lead.check?.message ?? '', /choose independent/);
  await assert.rejects(
    async () => f.runtime.approveLead({ id: lead.id, version: lead.version, digest: lead.digest!, approver: 'operator (board)', note: '', relayed: false }),
    /Lead check failed/,
  );
  assert.equal(f.runtime.store.tasks().length, 0);
});

test('catalogue identity drift between Ready and promotion refuses before task binding', async t => {
  const f = await fixture(t);
  const body = brief('  scope: general\n  profileRequests:\n    worker:\n      profileId: luna\n      reason: Luna implements\n      required: true\n    reviewer:\n      profileId: sol\n      reason: Sol reviews\n      required: true\n');
  const lead = await f.runtime.addLead({
    repositories: [{ origin: f.repo, path: f.repo }],
    title: 'Distinct models',
    body,
    lanes: [],
    author: 'planner',
  });
  assert.equal(lead.check?.ok, true, lead.check?.message);
  f.runtime.approveLead({ id: lead.id, version: lead.version, digest: lead.digest!, approver: 'operator (board)', note: '', relayed: false });
  f.runtime.engine.profiles = profiles.map(item => item.id === 'sol' ? { ...item, model: 'gpt-6-luna' } : item);
  await assert.rejects(
    f.runtime.promoteLeadToTask({ id: lead.id, note: '', board: true }),
    /share model gpt-6-luna/,
  );
  assert.equal(f.runtime.store.tasks().length, 0);
  assert.equal(f.runtime.store.lead(lead.id).approval?.digest, briefDigest(body));
});

test('direct brief submission refuses the same pairing before a task or workspace exists', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'brief.md');
  await writeFile(path, `---
title: Direct pairing
queue_approval: Operator approved fixture work
queue:
  complexity: medium
  scope: general
  profileRequests:
    worker:
      profileId: luna
      reason: Luna implements
      required: true
    reviewer:
      profileId: luna-reviewer
      reason: Luna reviews
      required: true
---

## Outcome

Direct submission.
`);
  await assert.rejects(
    f.runtime.submitHandoff({ briefPath: path, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true }),
    /share model gpt-6-luna/,
  );
  const prepared = await prepareHandoff({ briefPath: path, repoPath: f.repo, originAgentId: 'origin', baseBranch: 'main', dryRun: true });
  const acceptance = await f.runtime.engine.startSubmission(prepared.submission, true);
  assert.ok('accepted' in acceptance);
  const settled = await f.runtime.engine.awaitOperation(acceptance.operation.id, 8_000);
  assert.equal(settled.state, 'failed');
  assert.match(settled.diagnostic, /share model gpt-6-luna/);
  assert.doesNotMatch(settled.diagnostic, /No eligible/);
  assert.equal(f.runtime.store.tasks().length, 0);
  assert.ok(f.runtime.store.operations().every(operation => !operation.taskId));
});

test('an unrequested very_high-cost reviewer is no independent route at preflight, as at selection (papercut 09748034)', () => {
  // Only Luna and an unflagged very_high Sol can review: Sol is by-request by rule.
  const frontierOnly = [
    entry('luna', ['worker', 'reviewer']),
    entry('sol', ['reviewer'], { cost: 'very_high' }),
    entry('muse', ['worker'], { enabled: false }),
    entry('opaque', ['worker']),
  ];
  const message = conflict({ profileRequests: { worker: required('luna'), reviewer: optional('luna') } }, profiles, frontierOnly);
  assert.match(message ?? '', /required worker luna \(gpt-6-luna\) leaves no independent reviewer route/);
  // An explicit reviewer request for Sol is the owner's choice and passes.
  assert.equal(conflict({ profileRequests: { worker: required('luna'), reviewer: required('sol') } }, profiles, frontierOnly), null);
});
