import { fakeAdapter, profile } from './support/fakes';
import { stepEngine } from './support/engine-step';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkPolicyObservationKey, classifyGithubMerge, mergeGate, observeCheckClassification, partitionPrChecks, requiredCheckPolicyCapability, requiredCheckRequirements, requiredChecks, type CheckRequirements, type CheckRequirementTransport, type PrCheck} from '../core/forge/index';
import {runSchema, submissionSchema, type Completion, type Profile, type Run, type Task} from '../shared/contracts';
import {Store} from '../core/store/store';
import {occupiesSlot} from '../core/dispatch/capacity';
import {Engine} from '../core/engine';
import type {Adapter, AgentObservation} from '../core/host';
import type {ResolutionAdapter} from '../core/resolution';
import {git} from '../core/git/index';
import {observedParticipantTimeline, toolTimelinePage} from './support/tool-timeline';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const job = 'https://github.com/example/repo/actions/runs/9/job/1';
const actionsApp = 15368;
const requirement = (context: string, appId: number | null = null, source: 'protection-check' | 'ruleset' | 'protection-context' = 'ruleset') => ({context, appId, source});
const known = (requirements: ReturnType<typeof requirement>[]): Extract<CheckRequirements, {known: true}> => ({known: true, requirements, sources: {classicProtection: false, rulesets: true}});
const checkRun = (name: string, conclusion: string, appId: number | null = actionsApp): PrCheck => ({__typename: 'CheckRun', name, status: 'COMPLETED', conclusion, detailsUrl: job, ...(appId === null ? {} : {checkSuite: {app: {databaseId: appId}}})});

test('a dispatch-held parked task without a live agent does not occupy a task slot', async () => {
  const f = fixture();
  try {
    const parked = {...f.current(), held: true, holdOwner: 'operator', holdReason: 'paused', holdAt: new Date().toISOString(), holdGeneration: 1, holdUntil: null, phase: 'needs_attention' as const};
    assert.equal(occupiesSlot(parked), false);
    f.store.putRun({ id: 'live-reviewer', taskId: parked.id, role: 'reviewer', generation: 1, head, base: head, agentId: 'reviewer', workspaceId: 'workspace', profile: null, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: true, idleSince: null, completion: null, released: false } as Run);
    assert.equal(occupiesSlot(parked, f.store.runs(parked.id)), true, 'a live reviewer run keeps its slot while dispatch is held');
    f.store.putRun({ ...f.store.run('live-reviewer')!, status: 'finished', active: false, released: true });
    assert.equal(occupiesSlot(parked, f.store.runs(parked.id)), false, 'a released thread frees the slot');
  } finally { await f.close(); }
});

// ---------- requirement discovery ----------

test('required check discovery reads classic protection and paginated rulesets with app bindings', async () => {
  const discovered = await requiredCheckRequirements({} as Task, 'acme', 'repo', 'main', async (_t, endpoint, args) => {
    if (endpoint.endsWith('/protection/required_status_checks')) return {strict: false, contexts: ['legacy', 'build'], checks: [{context: 'build', app_id: actionsApp}]};
    assert.equal(endpoint, 'repos/acme/repo/rules/branches/main?per_page=100');
    assert.deepEqual(args, ['--paginate', '--slurp'], 'ruleset rules are read with explicit pagination');
    return [
      [{type: 'required_status_checks', parameters: {required_status_checks: [{context: 'qa', integration_id: actionsApp}]}}],
      [{type: 'deletion'}],
      [{type: 'required_status_checks', parameters: {required_status_checks: [{context: 'build', integration_id: null}]}}],
    ];
  });
  assert.deepEqual(discovered, {
    known: true,
    requirements: [
      {context: 'build', appId: actionsApp, source: 'protection-check'},
      {context: 'legacy', appId: null, source: 'protection-context'},
      {context: 'qa', appId: actionsApp, source: 'ruleset'},
      {context: 'build', appId: null, source: 'ruleset'},
    ],
    sources: {classicProtection: true, rulesets: true},
  });
});

test('positively absent requirements are known; every unreadable, refused, ambiguous or malformed observation is unknown', async () => {
  const only = (protection: () => Promise<unknown>, rules: () => Promise<unknown>) => async (_t: Task, endpoint: string) =>
    endpoint.endsWith('/protection/required_status_checks') ? protection() : rules();
  const failure = (status: number, message: string) => () => Promise.reject(Object.assign(new Error('Command failed: gh api'), {stderr: `gh: ${message} (HTTP ${status})`}));
  const notProtected = failure(404, 'Branch not protected');
  const genericNotFound = failure(404, 'Not Found');
  const planLimited = failure(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.');
  const forbidden = failure(403, 'Resource not accessible by integration');
  const offline = () => Promise.reject(new Error('dial tcp: no route to host'));

  // Only GitHub's own absent-state answers are positive evidence: "Branch not
  // protected" (and the refusal that says this repository cannot configure branch
  // protection at all) with an empty ruleset page are a known, empty requirement
  // set — the one case advisory mode may proceed on.
  assert.deepEqual(await requiredCheckRequirements({} as Task, 'acme', 'repo', 'main', only(notProtected, async () => [[]])),
    {known: true, requirements: [], sources: {classicProtection: true, rulesets: true}});
  assert.deepEqual(await requiredCheckRequirements({} as Task, 'acme', 'repo', 'main', only(planLimited, async () => [[]])),
    {known: true, requirements: [], sources: {classicProtection: true, rulesets: true}});

  for (const [label, transport, expected] of [
    // GitHub returns 404 for resources the caller may not read; a generic Not
    // Found is never proof that this repository has no protection.
    ['ambiguous 404', only(genericNotFound, async () => [[]]), /classic required status checks are unavailable: .*HTTP 404/],
    ['authorization', only(forbidden, async () => [[]]), /classic required status checks are unavailable: .*HTTP 403/],
    ['transport', only(notProtected, offline), /branch rules are unavailable/],
    ['no protection record', only(async () => null, async () => [[]]), /returned no record/],
    ['malformed contexts', only(async () => ({contexts: 'legacy'}), async () => [[]]), /contexts are malformed/],
    ['malformed app binding', only(async () => ({contexts: [], checks: [{context: 'build', app_id: 'not-an-app'}]}), async () => [[]]), /app binding is malformed/],
    ['malformed pagination', only(notProtected, async () => [[{type: 'required_status_checks'}], {type: 'deletion'}]), /malformed or pagination is incomplete/],
    ['rule without a discriminator', only(notProtected, async () => [[{}]]), /missing its type discriminator/],
    ['malformed ruleset rule', only(notProtected, async () => [[{type: 'required_status_checks', parameters: {}}]]), /ruleset required status checks rule is malformed/],
    ['malformed required context', only(notProtected, async () => [[{type: 'required_status_checks', parameters: {required_status_checks: [{integration_id: 1}]}}]]), /ruleset required status check is malformed/],
  ] as const) {
    const result = await requiredCheckRequirements({} as Task, 'acme', 'repo', 'main', transport as never);
    assert.equal(result.known, false, `${label} evidence must stay unknown`);
    if (result.known) throw new Error('unreachable');
    assert.match(result.reason, expected, label);
  }
  // A recognized unrelated rule keeps discovery known.
  assert.deepEqual(await requiredCheckRequirements({} as Task, 'acme', 'repo', 'main', only(notProtected, async () => [[{type: 'deletion'}], [{type: 'pull_request'}]] )),
    {known: true, requirements: [], sources: {classicProtection: true, rulesets: true}});
});

// ---------- activation capability ----------

/**
 * Task 393: `repository.set` reads this before it accepts `checksPolicy:
 * "required"`. The canonical repository and its own default branch come from
 * GitHub; every unreadable, refused or malformed surface refuses activation so
 * a plan or permission failure can never become an empty requirement set.
 */
test('required-check activation needs a positively readable requirement surface and never guesses a branch', async () => {
  const planLimited = Object.assign(new Error('Command failed: gh api'), {stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'});
  const record = {full_name: 'acme/repo', default_branch: 'trunk', private: true};
  const surface = (overrides: {record?: () => Promise<unknown>; classic?: () => Promise<unknown>; rules?: () => Promise<unknown>} = {}) => {
    const calls: string[] = [];
    const transport: CheckRequirementTransport = async (_t, endpoint, args) => {
      calls.push(`${endpoint}${args ? ` ${args.join(' ')}` : ''}`);
      if (endpoint === 'repos/acme/repo') return (overrides.record ?? (async () => record))();
      if (endpoint.endsWith('/protection/required_status_checks')) return (overrides.classic ?? (async () => ({strict: false, contexts: ['build'], checks: [{context: 'build', app_id: actionsApp}]})))();
      if (endpoint.includes('/rules/branches/')) return (overrides.rules ?? (async () => [[{type: 'required_status_checks', parameters: {required_status_checks: [{context: 'qa', integration_id: 7}]}}]]))();
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    return {calls, transport};
  };
  const failure = (status: number, message: string) => () => Promise.reject(Object.assign(new Error('Command failed: gh api'), {stderr: `gh: ${message} (HTTP ${status})`}));

  // A supported, non-empty surface permits activation and reports only the count.
  const supported = surface();
  assert.deepEqual(await requiredCheckPolicyCapability({} as Task, 'acme', 'repo', supported.transport),
    {supported: true, branch: 'trunk', requirements: {known: true, required: 2}});
  assert.deepEqual(supported.calls, [
    'repos/acme/repo',
    'repos/acme/repo/branches/trunk/protection/required_status_checks',
    'repos/acme/repo/rules/branches/trunk?per_page=100 --paginate --slurp',
  ], 'the repository\'s own default branch is read, never an assumed main');
  assert.equal(supported.calls.some(call => /\/main/.test(call)), false, 'no branch is guessed');

  // GitHub's own positively-absent answers and an empty ruleset page are readable.
  const empty = surface({classic: failure(404, 'Branch not protected'), rules: async () => [[]]});
  assert.deepEqual(await requiredCheckPolicyCapability({} as Task, 'acme', 'repo', empty.transport),
    {supported: true, branch: 'trunk', requirements: {known: true, required: 0}});

  // The exact private-plan refusal is an actionable unsupported capability, on
  // either requirement surface, and never reads as an empty requirement set.
  for (const [label, overrides] of [
    ['classic plan refusal', {classic: () => Promise.reject(planLimited)}],
    ['ruleset plan refusal', {rules: () => Promise.reject(planLimited)}],
  ] as const) {
    const result = await requiredCheckPolicyCapability({} as Task, 'acme', 'repo', surface(overrides).transport);
    assert.equal(result.supported, false, label);
    if (result.supported) throw new Error('unreachable');
    assert.equal(result.kind, 'unsupported', label);
    assert.equal(result.branch, 'trunk', label);
    assert.match(result.reason, /plan or visibility[\s\S]*HTTP 403/, label);
    assert.match(result.reason, /Make the repository public or upgrade its plan, or keep the default "all" policy/, `${label} names what the owner can do`);
    assert.doesNotMatch(result.reason, /no required checks|empty/, `${label} never claims an empty requirement set`);
  }

  // Every other failure class stays unknown and refuses: authorization, missing
  // permission, transport, malformed and pagination-incomplete evidence, an
  // unreadable repository record, no default branch and a non-canonical name.
  for (const [label, overrides, expected] of [
    ['ambiguous 404', {classic: failure(404, 'Not Found')}, /could not be established: classic required status checks are unavailable: [\s\S]*HTTP 404/],
    ['authorization', {classic: failure(403, 'Resource not accessible by integration')}, /could not be established: [\s\S]*HTTP 403/],
    ['bad credentials', {classic: failure(401, 'Bad credentials')}, /could not be established: [\s\S]*HTTP 401/],
    ['transport', {rules: () => Promise.reject(new Error('dial tcp: no route to host'))}, /could not be established: branch rules are unavailable/],
    ['malformed classic', {classic: async () => ({contexts: 'build'})}, /could not be established: classic required status check contexts are malformed/],
    ['malformed pagination', {rules: async () => [[{type: 'deletion'}], {type: 'deletion'}]}, /could not be established: branch rules are malformed or pagination is incomplete/],
    ['unreadable repository record', {record: () => Promise.reject(new Error('dial tcp: no route to host'))}, /repository record for acme\/repo could not be read, so its default branch is unknown/],
    ['no default branch', {record: async () => ({full_name: 'acme/repo'})}, /reported no default branch/],
    ['non-canonical name', {record: async () => ({full_name: 'acme/renamed', default_branch: 'trunk'})}, /GitHub resolves acme\/repo to acme\/renamed; the repository identity is not canonical/],
  ] as const) {
    const result = await requiredCheckPolicyCapability({} as Task, 'acme', 'repo', surface(overrides).transport);
    assert.equal(result.supported, false, label);
    if (result.supported) throw new Error('unreachable');
    assert.equal(result.kind, 'unknown', label);
    assert.match(result.reason, expected, label);
  }
});

// Exercise the production observer without network access.
const observePolicy = (checks: PrCheck[], history: Parameters<typeof observeCheckClassification>[2], policy: Parameters<typeof observeCheckClassification>[3], requirements?: CheckRequirements) =>
  observeCheckClassification({} as Task, checks, history, policy, requirements, 'acme', 'repo', async () => { throw new Error('unexpected evidence request'); });

// ---------- classification ----------

test('the default policy keeps every hosted check blocking exactly as before', async () => {
  const failing = [checkRun('macos-gateway', 'FAILURE')];
  const blocked = await observePolicy(failing, undefined, 'all');
  assert.equal(blocked.checksFailed, true);
  assert.match(blocked.wait, /macos-gateway/);
  assert.equal(blocked.advisory, undefined, 'the default policy records no advisory classification');
  assert.equal(blocked.checksPolicy, 'all');
  assert.equal((await observePolicy([], undefined, 'all')).wait, '');
  assert.equal((await observePolicy([{__typename: 'StatusContext', context: 'legacy', state: 'EXPECTED'}], undefined, 'all')).pendingCheck, true);
});

test('an advisory policy passes non-required failure, cancellation and pending work as recorded evidence', async () => {
  const requirements = known([requirement('build', actionsApp)]);
  const checks: PrCheck[] = [
    checkRun('build', 'SUCCESS'),
    checkRun('macos-gateway', 'FAILURE'),
    {__typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: job},
    {__typename: 'CheckRun', name: 'docs', status: 'IN_PROGRESS', detailsUrl: job},
    {__typename: 'StatusContext', context: 'legacy-lint', state: 'FAILURE'},
  ];
  const result = await observePolicy(checks, undefined, 'required', requirements);
  assert.equal(result.wait, '');
  assert.equal(result.checksFailed, false);
  assert.equal(result.pendingCheck, undefined);
  assert.equal(result.infrastructure, undefined, 'an advisory cancellation never enters the infrastructure path');
  assert.deepEqual(result.requirements, {known: true, required: 1});
  assert.deepEqual(result.advisory?.map(check => `${check.identity}:${check.name}:${check.state}:${check.conclusion}`), [
    'CheckRun:macos-gateway:COMPLETED:FAILURE',
    'CheckRun:deploy:COMPLETED:CANCELLED',
    'CheckRun:docs:IN_PROGRESS:',
    'StatusContext:legacy-lint:FAILURE:',
  ]);
  assert.equal(result.advisory?.[0]?.jobUrl, job);
});

test('required checks still block under an advisory policy: failed, pending, overdue and missing', async () => {
  const requirements = known([requirement('build', actionsApp)]);
  const failed = await observePolicy([checkRun('build', 'FAILURE'), checkRun('macos-gateway', 'SUCCESS')], undefined, 'required', requirements);
  assert.equal(failed.checksFailed, true);
  assert.match(failed.wait, /build/);
  assert.doesNotMatch(failed.wait, /macos-gateway/);

  for (const status of ['QUEUED', 'IN_PROGRESS'] as const) {
    const pending = await observePolicy([{__typename: 'CheckRun', name: 'build', status, detailsUrl: job, checkSuite: {app: {databaseId: actionsApp}}}], undefined, 'required', requirements);
    assert.equal(pending.pendingCheck, true, `${status} is a pending wait`);
    assert.equal(pending.checksFailed, false, `${status} is not a failed check`);
    assert.equal(pending.overdue, undefined, `${status} is not attention before its bound`);
  }

  const overdue = await observePolicy([{__typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', startedAt: '2026-10-05T00:00:00.000Z', detailsUrl: job, checkSuite: {app: {databaseId: actionsApp}}}], {now: Date.parse('2026-10-05T01:00:00.000Z')}, 'required', requirements);
  assert.equal(overdue.overdue, true);
  assert.match(overdue.wait, /Required check 'build'.*has been pending past its deadline/);

  // A required context nobody reported remains a visible pending requirement with
  // its bounded deadline, never an absent requirement that merges by default.
  const missing = await observePolicy([checkRun('macos-gateway', 'FAILURE')], undefined, 'required', requirements);
  assert.equal(missing.checksFailed, false);
  assert.equal(missing.pendingCheck, true);
  assert.equal(missing.wait, 'PR checks are pending');
  assert.deepEqual(missing.advisory?.map(check => check.name), ['macos-gateway']);
});

test('a classic app binding is never widened by the duplicate legacy contexts entry', async () => {
  // GitHub returns contexts ["build"] and checks [{context:"build", app_id}] for
  // the same requirement. The app binding is the narrower truth: a same-named
  // failure from another app must stay advisory rather than gate the task.
  const requirements = await requiredCheckRequirements({} as Task, 'acme', 'repo', 'main', async (_t, endpoint) =>
    endpoint.endsWith('/protection/required_status_checks')
      ? {strict: false, contexts: ['build'], checks: [{context: 'build', app_id: actionsApp}]}
      : [[]]);
  assert.deepEqual(requirements, {known: true, requirements: [{context: 'build', appId: actionsApp, source: 'protection-check'}], sources: {classicProtection: true, rulesets: true}});
  const classified = await observePolicy([checkRun('build', 'SUCCESS'), checkRun('build', 'FAILURE', 99)], undefined, 'required', requirements);
  assert.equal(classified.checksFailed, false);
  assert.equal(classified.wait, '');
  assert.deepEqual(classified.advisory?.map(check => `${check.name}:${check.classification}:${check.conclusion}`), ['build:advisory:FAILURE']);
  assert.deepEqual(classified.requiredEvidence?.map(check => `${check.name}:${check.classification}:${check.conclusion}`), ['build:required:SUCCESS']);
});

test('app-bound requirements are not satisfied by a same-named check from another app or a legacy status context', async () => {
  const requirements = known([requirement('build', actionsApp)]);
  // The required Actions check passes; a same-named failure from another app is advisory.
  const collision = await observePolicy([checkRun('build', 'SUCCESS'), checkRun('build', 'FAILURE', 99)], undefined, 'required', requirements);
  assert.equal(collision.checksFailed, false);
  assert.deepEqual(collision.advisory?.map(check => `${check.name}:${check.conclusion}`), ['build:FAILURE']);

  // The required app's own check fails while another app's same-named check passes.
  const requiredFails = await observePolicy([checkRun('build', 'FAILURE'), checkRun('build', 'SUCCESS', 99)], undefined, 'required', requirements);
  assert.equal(requiredFails.checksFailed, true);
  assert.match(requiredFails.wait, /PR checks failed: build/);
  assert.equal(requiredFails.advisory?.length, 1);

  // A legacy commit status with the right name carries no app identity.
  const legacy = await observePolicy([{__typename: 'StatusContext', context: 'build', state: 'SUCCESS'}], undefined, 'required', requirements);
  assert.equal(legacy.wait, 'PR checks are pending');
  assert.deepEqual(legacy.advisory?.map(check => check.identity), ['StatusContext']);

  // An unnamed-app requirement accepts either surface, and a mixed combined
  // status/check-run rollup still classifies each context once.
  const contextOnly = known([requirement('build', null, 'protection-context'), requirement('legacy', null, 'protection-context')]);
  const combined = await observePolicy([checkRun('build', 'SUCCESS', null), {__typename: 'StatusContext', context: 'legacy', state: 'SUCCESS'}, checkRun('extra', 'FAILURE')], undefined, 'required', contextOnly);
  assert.equal(combined.wait, '');
  assert.deepEqual(combined.advisory?.map(check => check.name), ['extra']);
  assert.deepEqual(partitionPrChecks([checkRun('build', 'SUCCESS', null), {__typename: 'StatusContext', context: 'legacy', state: 'SUCCESS'}], contextOnly.requirements).advisory, []);
});

test('unreadable requirement evidence holds visibly instead of becoming an empty requirement set', async () => {
  const hold = await observePolicy([checkRun('macos-gateway', 'FAILURE')], undefined, 'required', {known: false, reason: 'classic required status checks are unavailable: HTTP 403'});
  assert.equal(hold.wait, 'GitHub required checks for this base branch could not be established: classic required status checks are unavailable: HTTP 403');
  assert.equal(hold.pendingCheck, true);
  assert.equal(hold.checksFailed, false);
  assert.deepEqual(hold.requirements, {known: false, required: 0, reason: 'classic required status checks are unavailable: HTTP 403'});
  assert.equal(hold.advisory, undefined, 'no check is called advisory without knowing the requirements');
});

test('advisory checks are never enriched, so an advisory cancellation cannot spend the rerun intent', async () => {
  const calls: string[] = [];
  const transport = async (_t: Task, endpoint: string) => { calls.push(endpoint); throw new Error('no runner evidence'); };
  const requirements = known([requirement('build', actionsApp)]);
  const classification = await observeCheckClassification({} as Task, [
    checkRun('build', 'SUCCESS'),
    {__typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: job},
    {__typename: 'CheckRun', name: 'docs', status: 'QUEUED', detailsUrl: job},
  ], undefined, 'required', requirements, 'acme', 'repo', transport as never);
  assert.deepEqual(calls, [], 'only required checks are enriched');
  assert.equal(classification.infrastructure, undefined);
  assert.equal(classification.pendingCheck, undefined);
  assert.equal(classification.wait, '');

  // A required cancellation without step evidence still holds for re-observation.
  const requiredHold = await observeCheckClassification({} as Task, [{__typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: job, checkSuite: {app: {databaseId: actionsApp}}}], undefined, 'required', requirements, 'acme', 'repo', transport as never);
  assert.equal(requiredHold.pendingCheck, true);
  assert.match(requiredHold.wait, /Required checks lack step evidence/);
});

test('check evidence keeps the GitHub identity, app binding, legacy target URL and required/advisory classification', async () => {
  const requirements = known([requirement('build', actionsApp), requirement('legacy', null, 'protection-context')]);
  const observed: PrCheck[] = [
    {__typename: 'CheckRun', databaseId: 8123, name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: job, checkSuite: {app: {databaseId: actionsApp}}},
    {__typename: 'StatusContext', context: 'legacy', state: 'SUCCESS', targetUrl: 'https://ci.example.test/legacy/1'},
    {__typename: 'CheckRun', databaseId: 8124, name: 'macos-gateway', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: job, checkSuite: {app: {databaseId: 99}}},
  ];
  const result = await observePolicy(observed, undefined, 'required', requirements);
  assert.equal(result.wait, '');
  assert.deepEqual(result.requiredEvidence, [
    {identity: 'CheckRun', name: 'build', state: 'COMPLETED', conclusion: 'SUCCESS', jobUrl: job, databaseId: 8123, appId: actionsApp, classification: 'required'},
    {identity: 'StatusContext', name: 'legacy', state: 'SUCCESS', conclusion: '', jobUrl: 'https://ci.example.test/legacy/1', databaseId: null, appId: null, classification: 'required'},
  ]);
  assert.deepEqual(result.advisory?.map(check => [check.name, check.databaseId, check.appId, check.classification, check.jobUrl]), [
    ['macos-gateway', 8124, 99, 'advisory', job],
  ]);
  // A required context nobody reported is recorded as evidence, not dropped.
  const missing = await observePolicy([], undefined, 'required', known([requirement('qa', actionsApp)]));
  assert.deepEqual(missing.requiredEvidence?.map(check => `${check.name}:${check.state}`), ['qa:EXPECTED']);
});

test('GitHub UNSTABLE only stops blocking under a positively established advisory policy', async () => {
  assert.deepEqual(classifyGithubMerge({mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE'}, false, {advisoryChecks: true}), {wait: ''});
  assert.match(classifyGithubMerge({mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE'}, false).wait, /UNSTABLE/);
  assert.match(classifyGithubMerge({mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED'}, false, {advisoryChecks: true}).wait, /BLOCKED/);
  assert.equal(classifyGithubMerge({mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY'}, false, {advisoryChecks: true}).needsRebase, true);
  assert.match(classifyGithubMerge({mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN'}, false, {advisoryChecks: true}).wait, /branch rules must be satisfied/);
});

// ---------- the real merge gate against a fake forge ----------

type FakeResponse = {status?: number; message?: string; body?: unknown};

async function gateFixture(): Promise<{root: string; integration: string; task: Task; head: string; base: string; setForge: (config: Record<string, FakeResponse>) => void; restorePath: () => void; calls: () => string[]}> {
  const root = mkdtempSync(join(tmpdir(), 'ns-checks-gate-'));
  await git(root, 'init', '--bare', '--initial-branch=main', 'origin.git');
  await git(root, 'clone', join(root, 'origin.git'), 'integration');
  const integration = join(root, 'integration');
  for (const repo of [integration]) { await git(repo, 'config', 'user.name', 'Queue test'); await git(repo, 'config', 'user.email', 'queue@example.invalid'); }
  writeFileSync(join(integration, 'base.txt'), 'base');
  await git(integration, 'add', 'base.txt'); await git(integration, 'commit', '-m', 'base'); await git(integration, 'push', '-u', 'origin', 'main');
  await git(root, 'clone', '--branch', 'main', join(root, 'origin.git'), 'worker');
  const worker = join(root, 'worker');
  await git(worker, 'config', 'user.name', 'Queue test'); await git(worker, 'config', 'user.email', 'queue@example.invalid');
  await git(worker, 'checkout', '-b', 'ns-checks');
  writeFileSync(join(worker, 'feature.txt'), 'feature');
  await git(worker, 'add', 'feature.txt'); await git(worker, 'commit', '-m', 'task'); const taskHead = await git(worker, 'rev-parse', 'HEAD');
  await git(worker, 'push', '-u', 'origin', 'ns-checks');
  // verifyPr and the gate resolve the GitHub identity from the origin remote,
  // while the integration gate still fetches the disposable local origin.
  const github = 'git@github.com:acme/repo.git';
  for (const repo of [integration, worker]) await git(repo, 'remote', 'set-url', 'origin', github);
  const taskBase = await git(integration, 'rev-parse', 'HEAD');
  const task = {
    repoPath: integration, baseBranch: 'main', branch: 'ns-checks', directory: worker, prHead: taskHead,
    skipPRReview: true, resolution: {review: null}, completion: {prNumber: 1},
  } as unknown as Task;
  const bin = join(root, 'bin'); mkdirSync(bin, {recursive: true});
  const configPath = join(root, 'fake-gh.json');
  const script = join(bin, 'gh');
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, 'utf8'));
const args = process.argv.slice(2);
const key = args[0] === 'api' ? args[1] : args.slice(0, 2).join(' ');
fs.appendFileSync(process.env.FAKE_GH_CONFIG + '.calls', key + '\\n');
const entry = config[key] ?? config[String(key).replace(/\\?.*$/, '')];
if (!entry) { process.stderr.write('gh: no fake response for ' + key + '\\n'); process.exit(1); }
if (entry.status) { process.stderr.write('gh: ' + (entry.message ?? 'Not Found') + ' (HTTP ' + entry.status + ')\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(entry.body));
`);
  chmodSync(script, 0o755);
  // The integration gate still fetches the disposable local origin: a fake ssh
  // answers the GitHub-shaped origin URL with the local bare repository.
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack ${JSON.stringify(join(root, 'origin.git'))}\n`);
  chmodSync(ssh, 0o755);
  const priorPath = process.env.PATH, priorConfig = process.env.FAKE_GH_CONFIG;
  process.env.PATH = `${bin}:${priorPath ?? ''}`;
  process.env.FAKE_GH_CONFIG = configPath;
  return {
    root, integration, task, head: taskHead, base: taskBase,
    calls: () => readFileSync(configPath + '.calls', 'utf8').trim().split('\n'),
    setForge: config => writeFileSync(configPath, JSON.stringify(config)),
    restorePath: () => { process.env.PATH = priorPath; if (priorConfig === undefined) delete process.env.FAKE_GH_CONFIG; else process.env.FAKE_GH_CONFIG = priorConfig; },
  };
}

function forgeConfig(input: {head: string; base: string; checks: PrCheck[]; mergeStateStatus?: string; protection?: FakeResponse; rules?: FakeResponse}): Record<string, FakeResponse> {
  return {
    'pr view': {body: {number: 1, url: 'https://github.com/acme/repo/pull/1', state: 'OPEN', isDraft: false, headRefName: 'ns-checks', baseRefName: 'main', headRefOid: input.head}},
    graphql: {body: {data: {repository: {pullRequest: {
      headRefOid: input.head, baseRefOid: input.base, baseRefName: 'main', isDraft: false, state: 'OPEN',
      mergeable: 'MERGEABLE', mergeStateStatus: input.mergeStateStatus ?? 'CLEAN', reviewDecision: null,
      reviewThreads: {nodes: [], pageInfo: {hasNextPage: false}},
      statusCheckRollup: {contexts: {nodes: input.checks, pageInfo: {hasNextPage: false}}},
    }}}}},
    'repos/acme/repo/pulls/1': {body: {state: 'OPEN', draft: false, html_url: 'https://github.com/acme/repo/pull/1', head: {ref: 'ns-checks', sha: input.head}, base: {ref: 'main'}}},
    'repos/acme/repo/branches/main/protection/required_status_checks': input.protection ?? {status: 404, message: 'Branch not protected'},
    'repos/acme/repo/rules/branches/main': input.rules ?? {body: []},
  };
}

test('one gate shares branch rule and protection reads within the attempt', async () => {
  const f = await gateFixture();
  try {
    f.setForge(forgeConfig({head: f.head, base: f.base, checks: []}));
    const gate = await mergeGate(f.task, undefined, null, 'required');
    assert.equal(gate.wait, '');
    assert.ok(gate.timings);
    console.log('merge-gate fixture steps', JSON.stringify(gate.timings));
    const calls = f.calls();
    assert.equal(calls.filter(call => call.includes('/rules/branches/')).length, 1);
    assert.equal(calls.filter(call => call.includes('/protection/required_status_checks')).length, 1);
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

test('the merge gate keeps the default blocking policy for an unrelated failure', async () => {
  const f = await gateFixture();
  try {
    f.setForge(forgeConfig({head: f.head, base: f.base, checks: [checkRun('macos-gateway', 'FAILURE')], mergeStateStatus: 'BLOCKED'}));
    const gate = await mergeGate(f.task);
    assert.equal(gate.checksFailed, true);
    assert.match(gate.wait, /PR checks failed: macos-gateway/);
    assert.equal(gate.checksPolicy, 'all', 'the default policy is reported, never left implicit');
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

test('the merge gate proceeds under an advisory policy with positively no required checks and records the negative evidence', async () => {
  const f = await gateFixture();
  try {
    f.setForge(forgeConfig({head: f.head, base: f.base, checks: [checkRun('macos-gateway', 'FAILURE'), {__typename: 'CheckRun', name: 'docs', status: 'IN_PROGRESS', detailsUrl: job}], mergeStateStatus: 'UNSTABLE'}));
    const gate = await mergeGate(f.task, undefined, null, 'required');
    assert.equal(gate.wait, '');
    assert.equal(gate.checksPolicy, 'required');
    assert.deepEqual(gate.requirements, {known: true, required: 0});
    assert.deepEqual(gate.advisory?.map(check => `${check.name}:${check.conclusion}`), ['macos-gateway:FAILURE', 'docs:']);
    const pending = await requiredChecks(f.task, undefined, 'required');
    assert.equal(pending.wait, '', 'the polling path takes the same classification');
    assert.equal(pending.advisory?.length, 2);
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

test('a merge-state wait keeps the exact-head check evidence the gate observed', async () => {
  const f = await gateFixture();
  try {
    f.setForge(forgeConfig({head: f.head, base: f.base, mergeStateStatus: 'BLOCKED',
      checks: [checkRun('build', 'SUCCESS'), checkRun('macos-gateway', 'FAILURE', 99)],
      rules: {body: [[{type: 'required_status_checks', parameters: {strict_required_status_checks_policy: false, required_status_checks: [{context: 'build', integration_id: actionsApp}]}}]]}}));
    const gate = await mergeGate(f.task, undefined, null, 'required');
    assert.notEqual(gate.checksFailed, true);
    assert.match(gate.wait, /BLOCKED/, 'an unrelated GitHub rule still blocks');
    assert.equal(gate.checksPolicy, 'required', 'the policy survives the merge-state wait');
    assert.deepEqual(gate.requirements, {known: true, required: 1});
    assert.deepEqual(gate.requiredEvidence?.map(check => `${check.name}:${check.classification}`), ['build:required']);
    assert.deepEqual(gate.advisory?.map(check => `${check.name}:${check.appId}:${check.classification}`), ['macos-gateway:99:advisory']);
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

test('a generic protection 404 is unreadable evidence, not an advisory green light', async () => {
  const f = await gateFixture();
  try {
    f.setForge({
      ...forgeConfig({head: f.head, base: f.base, checks: [checkRun('macos-gateway', 'FAILURE')], mergeStateStatus: 'UNSTABLE'}),
      'repos/acme/repo/branches/main/protection/required_status_checks': {status: 404, message: 'Not Found'},
    });
    // Task 1019 makes unreadable strict-rule evidence refuse the whole gate.
    await assert.rejects(mergeGate(f.task, undefined, null, 'required'), /HTTP 404/);
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

test('the merge gate blocks a failed required ruleset check under an advisory policy', async () => {
  const f = await gateFixture();
  try {
    f.setForge(forgeConfig({
      head: f.head, base: f.base, mergeStateStatus: 'BLOCKED',
      checks: [checkRun('qa', 'FAILURE'), checkRun('macos-gateway', 'FAILURE', 99)],
      rules: {body: [[{type: 'required_status_checks', parameters: {strict_required_status_checks_policy: false, required_status_checks: [{context: 'qa', integration_id: actionsApp}]}}]]},
    }));
    const gate = await mergeGate(f.task, undefined, null, 'required');
    assert.equal(gate.checksFailed, true);
    assert.match(gate.wait, /PR checks failed: qa \(job URL: /);
    assert.equal(gate.advisory?.length, 1);
    assert.equal(gate.advisory?.[0]?.name, 'macos-gateway');
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

test('an unreadable branch protection holds the merge gate instead of treating it as no requirements', async () => {
  const f = await gateFixture();
  try {
    f.setForge({
      ...forgeConfig({head: f.head, base: f.base, checks: [checkRun('macos-gateway', 'SUCCESS')]}),
      'repos/acme/repo/branches/main/protection/required_status_checks': {status: 403, message: 'Resource not accessible by integration'},
    });
    await assert.rejects(mergeGate(f.task, undefined, null, 'required'), /Resource not accessible by integration.*HTTP 403/);
  } finally { f.restorePath(); rmSync(f.root, {recursive: true, force: true}); }
});

// ---------- resolution paths ----------


function fixture(uncertainMergeRetryMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-checks-policy-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author'), reviewer = profile('reviewer'), coordinator = profile('coordinator');
  store.setMeta('paused', false);
  store.putRepository({origin: null, path: '/repo'}, 'agent', 'fixture keeps agent closeout');
  store.setMeta('pool', [
    {profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'], capability: 'medium', cost: 'low'},
    {profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'], capability: 'medium', cost: 'medium'},
    {profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'], capability: 'low', cost: 'very_low'},
  ]);
  const submitted = store.insert(submissionSchema.parse({submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin'}), 'host', 'handoff', base);
  const task = store.update(submitted.id, {phase: 'awaiting_review', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree', agentId: 'worker', runId: 'initial', profile: worker, workerModel: worker.model, prHead: head, prUrl: 'https://github.com/example/repo/pull/1', agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString(), completion: {taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1}});
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, {id, workspaceId, status: 'idle', active: false, permissions: false, error: ''});
  idle('worker');
  const tokens = new Map<string, string>(), creates: Run[] = [];
  let merges = 0, reruns: string[][] = [];
  const gate = (_task: Task): Record<string, unknown> => ({head, base, wait: ""});
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coordinator], validate: async () => base, verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error('Review must not create workspaces'); }, createAgent: async () => { throw new Error('No initial dispatch'); },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent missing'); return state; },
    agentTimelinePage: observedParticipantTimeline(states),
    verifyPr: async () => ({head, url: task.prUrl!}),
    createRun: async (t, r, token) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, {id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: ''}); return {id, workspaceId: r.workspaceId}; },
    sendRun: async (t, r, token) => { tokens.set(r.id, token); states.set(r.agentId!, {...states.get(r.agentId!)!, active: true, status: 'running'}); }, findRunAgents: async () => [],
    verifyReview: async (t, r, c) => { if (c.head !== head) throw new Error('Stale PR head'); },
    mergeGate: async t => gate(t) as never,
    requiredChecks: async t => gate(t) as never,
    rerunFailedWorkflowRuns: async (_t, runIds) => { reruns.push(runIds); return runIds; },
    merge: async () => { merges++; },
    merged: async () => ({merged: merges > 0, commit: merged, head, base: 'main'}), syncMain: async () => merged, verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0, () => true, undefined, uncertainMergeRetryMs); engine.profiles = [worker, reviewer, coordinator];
  const current = () => store.task(task.id);
  const run = () => store.run(current().resolution.currentRunId!)!;
  // `wake` lets a test observe the accepted result before the resolution pass
  // that consumes it, so a defect applied at the merge gate is not already past it.
  async function report(status: Completion['status'], wake = true, reportedHead: string | undefined = head) {
    const r = run(); idle(r.agentId!, r.workspaceId);
    const input: Completion = {eventId: randomUUID(), taskId: task.id, runId: r.id, status, summary: status, ...(reportedHead ? {head: reportedHead} : {}),
      ...(r.role === 'reviewer' ? {reviewCommentId: 1} : {}), ...(r.role === 'closeout' ? {coordinatorGeneration: r.generation} : {}),
      ...(r.role === 'revision' ? {prNumber: current().completion?.prNumber} : {})};
    engine.resolution.complete(input, tokens.get(r.id)!); if (wake) await engine.wake(); return input;
  }
  return {dir, store, engine, adapter, task, current, run, report, creates, reruns, counts: () => ({merges}), close: async () => { await engine.stop(); store.close(); rmSync(dir, {recursive: true, force: true}); }};
}

test('an advisory policy merges past an unrelated failure, keeps the accepted review and records the exact head', async () => {
  const f = fixture();
  try {
    f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
    let seenPolicy = '';
    f.adapter.mergeGate = async (t, _history, _reviewer, policy) => {
      seenPolicy = String(policy);
      return {head: t.prHead!, base, wait: '', checksPolicy: 'required', requirements: {known: true, required: 0},
        advisory: [{identity: 'CheckRun', name: 'macos-gateway', state: 'COMPLETED', conclusion: 'FAILURE', jobUrl: job}]} as never;
    };
    await f.engine.wake();
    await f.report('ready_to_merge');
    for (let round = 0; round < 8 && f.counts().merges === 0; round++) await f.engine.wake();
    assert.equal(seenPolicy, 'required', 'the store policy reaches the merge gate');
    assert.equal(f.counts().merges, 1);
    assert.equal(f.current().phase, 'closing');
    assert.equal(f.creates.filter(run => run.role === 'revision').length, 0, 'an advisory failure never launches an author');
    assert.equal(f.current().resolution.review?.status, 'ready_to_merge', 'the accepted exact-head review is preserved');
    const observation = f.store.getMeta<{head: string; policy: string; advisory: {name: string; conclusion: string}[]}>(checkPolicyObservationKey(f.task.id))!;
    assert.equal(observation.head, head);
    assert.equal(observation.policy, 'required');
    assert.deepEqual(observation.advisory.map(check => `${check.name}:${check.conclusion}`), ['macos-gateway:FAILURE']);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'check_policy_observation' && /macos-gateway/.test(event.detail)), 'the negative evidence is visible in task detail');
    assert.deepEqual(f.reruns, [], 'an advisory failure never requests a CI rerun');
    assert.equal(f.creates.filter(run => run.role === 'verification').length, 0, 'an advisory result creates no verification run');
    assert.deepEqual(Object.keys(observation).sort(), ['advisory', 'digest', 'head', 'observedAt', 'policy', 'required', 'requirements', 'settingsRevision'],
      'the record holds check evidence only: no borrowed test proof and no validation claim');
  } finally { await f.close(); }
});

test('an advisory merge still refuses missing, partial, live or foreign participant evidence and sends no request', async () => {
  const shapes = [
    ['missing history', (f: ReturnType<typeof fixture>) => { f.adapter.agentTimelinePage = undefined; }, 'merging'],
    ['partial coverage', (f: ReturnType<typeof fixture>) => {
      f.adapter.agentTimelinePage = async () => ({entries: [], hasOlder: false}) as never;
    }, 'merging'],
    ['live tool', (f: ReturnType<typeof fixture>) => {
      f.adapter.agentTimelinePage = async () => toolTimelinePage([{timestamp: new Date().toISOString(),
        item: {type: 'tool_call', callId: 'live-tool', name: 'exec', status: 'running'}}]);
    }, 'merging'],
    // A participant observed in another workspace never reaches the gate: the
    // shared lease refuses the reviewer pass first.
    ['foreign workspace', (f: ReturnType<typeof fixture>) => {
      const observed = f.adapter.observe;
      f.adapter.observe = async id => id === 'worker'
        ? {...await observed(id), workspaceId: 'other-workspace'}
        : observed(id);
    }, 'reviewing'],
  ] as const;
  for (const [shape, apply, stopsAt] of shapes) {
    const f = fixture();
    try {
      f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
      let mergeRequests = 0;
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: '', checksPolicy: 'required',
        requirements: {known: true, required: 0}, advisory: []}) as never;
      await f.engine.wake();
      await f.report('ready_to_merge', false);
      // Only the participant evidence changes; the review itself is unchanged
      // and the real merge gate still reads it.
      apply(f);
      f.adapter.merge = async () => { mergeRequests++; };
      for (let round = 0; round < 8; round++) await f.engine.wake();
      assert.equal(mergeRequests, 0, `${shape}: the merge request predicate never runs`);
      assert.equal(f.counts().merges, 0, `${shape}: no merge is observed`);
      assert.equal(f.current().resolution.mergeIntent, false, `${shape}: no merge intent is recorded`);
      assert.equal(f.store.eventsAll(f.task.id).some(event => event.kind === 'merge_intent'), false, `${shape}: no merge intent event is written`);
      assert.equal(f.current().phase, stopsAt, `${shape}: the task stops before the merge request`);
      if (stopsAt === 'reviewing') assert.match(f.current().reason, /Agent workspace changed; lease is not safe/,
        `${shape}: the refusal names the foreign workspace`);
      else assert.equal(f.current().resolution.review?.status, 'ready_to_merge',
        `${shape}: the accepted exact-head review stays as evidence`);
      assert.equal(f.creates.filter(run => run.role === 'verification').length, 0, `${shape}: no verification run is spent`);
    } finally { await f.close(); }
  }
});

test('a policy change during the merge gate re-observes instead of merging on the stale advisory result', async () => {
  const f = fixture();
  try {
    f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
    const policies: string[] = [];
    f.adapter.mergeGate = async (t, _history, _reviewer, policy) => {
      policies.push(String(policy));
      if (policies.length === 1) {
        // The operator turns the repository blocking again while this gate is in
        // flight; its advisory pass must not authorise a merge.
        f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'all'});
        return {head: t.prHead!, base, wait: '', checksPolicy: 'required', requirements: {known: true, required: 0}, advisory: []} as never;
      }
      return {head: t.prHead!, base, wait: `PR checks failed: macos-gateway (job URL: ${job})`, checksFailed: true, checksPolicy: 'all'} as never;
    };
    await stepEngine(f.engine);
    await f.report('ready_to_merge', false);
    await stepEngine(f.engine);
    for (let round = 0; round < 6 && f.current().phase !== 'changes_requested'; round++) await stepEngine(f.engine);
    assert.deepEqual(policies, ['required', 'all'], 'the gate is re-observed under the current policy');
    assert.equal(f.counts().merges, 0, 'stale advisory evidence never authorises a merge');
    assert.equal(f.current().phase, 'changes_requested');
    assert.match(f.current().reason, /macos-gateway/);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'merge_gate_settings_changed'));
  } finally { await f.close(); }
});

test('a checks-policy change after the gate withdraws the final merge permission before the request', async () => {
  const f = fixture();
  try {
    f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
    let predicate: (() => boolean) | null = null;
    f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: '', checksPolicy: 'required', requirements: {known: true, required: 0}, advisory: []}) as never;
    f.adapter.merge = async (_t, allowed) => {
      predicate = allowed ?? null;
      // The operator turns the repository blocking again after the gate.
      f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'all'});
      assert.equal(predicate!(), false, 'the final permission boundary re-reads the settings revision');
      throw new Error('Paused before merge request');
    };
    await f.engine.wake();
    await f.report('ready_to_merge');
    for (let round = 0; round < 6 && !f.store.eventsAll(f.task.id).some(event => event.kind === 'merge_gate_settings_changed'); round++) await f.engine.wake();
    assert.ok(predicate, 'the merge request predicate was consulted');
    assert.equal(f.counts().merges, 0, 'no merge was sent');
    assert.equal(f.current().resolution.mergeIntent, true, 'the recorded intent is reconciled, not silently cleared');
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'merge_gate_settings_changed' && /not sent/.test(event.detail)),
      'the withdrawal is recorded before the later uncertainty hold');
  } finally { await f.close(); }
});

test('a fresh-gate hold or error past the uncertain-merge deadline escalates and retains the integration turn', async () => {
  for (const outcome of ['pending', 'error'] as const) {
    const f = fixture(60_000);
    try {
      const merge = f.adapter.merge!;
      let requests = 0;
      f.adapter.merge = async (t, allowed) => { requests++; await merge(t, allowed); if (requests === 1) throw new Error('Response lost'); };
      f.adapter.merged = async t => ({merged: false, commit: null, head: t.prHead!, base: 'main',
        proof: {proven: true, detail: 'exact open unmerged PR; no auto-merge or queue entry'}});
      await f.engine.wake();
      await f.report('ready_to_merge');
      for (let round = 0; round < 6 && f.current().phase !== 'merging'; round++) await f.engine.wake();
      assert.equal(f.counts().merges, 1);
      assert.equal(f.current().resolution.mergeIntent, true);
      // A complete non-merge proof that is already past the 30-minute bound.
      const old = new Date(Date.now() - 31 * 60_000).toISOString();
      f.store.update(f.task.id, {resolution: {...f.current().resolution, mergeRequestedAt: old, mergeProofSince: old}});
      f.adapter.mergeGate = outcome === 'pending'
        ? async t => ({head: t.prHead!, base, wait: 'PR checks are pending', pendingCheck: true}) as never
        : async () => { throw new Error('GraphQL transport unavailable'); };
      await f.engine.wake();
      assert.equal(f.counts().merges, 1, `${outcome}: no re-issue behind a gate that does not pass`);
      assert.equal(f.current().phase, 'needs_attention', `${outcome}: the bounded episode expires instead of waiting forever`);
      assert.equal(f.current().resolution.attention, true);
      assert.ok(f.current().resolution.integrationTurn, `${outcome}: unresolved merge intent retains the turn`);
      assert.equal(f.engine.resolution.integrationActive(f.current()), true);
      assert.equal(f.current().reason.startsWith('Uncertain merge requires operator attention:'), true, f.current().reason);
      assert.match(f.current().reason, outcome === 'pending' ? /fresh exact-head gate holds: PR checks are pending/ : /the gate observation failed: .*GraphQL transport unavailable/);
      assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'uncertain_merge_escalated'));
    } finally { await f.close(); }
  }
});

test('a failed required check still returns the same PR to its worker under an advisory policy', async () => {
  const f = fixture();
  try {
    f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
    f.store.update(f.task.id, {skipPRReview: true});
    f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: `PR checks failed: qa (job URL: ${job})`, checksFailed: true,
      checksPolicy: 'required', requirements: {known: true, required: 1}, advisory: []}) as never;
    await stepEngine(f.engine);
    for (let round = 0; round < 4 && f.current().phase !== 'changes_requested'; round++) await stepEngine(f.engine);
    assert.equal(f.counts().merges, 0);
    assert.equal(f.current().phase, 'changes_requested');
    assert.match(f.current().reason, /qa \(job URL: /);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'pre_merge_refused'));
    await f.engine.wake();
    assert.equal(f.run().role, 'revision', 'a required failure remains a semantic author return');
    // A head-only task with no review has no review to preserve, but the same
    // unchanged failure is still not worth another author turn.
    await f.report('ready_for_review');
    for (let round = 0; round < 4 && f.current().resolution.stop?.reason !== 'escalated'; round++) await f.engine.wake();
    assert.equal(f.current().resolution.stop?.reason, 'escalated');
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'planner_escalation_payload' && event.detail.includes('qa') && event.detail.includes(job)));
    assert.equal(f.counts().merges, 0);
    assert.equal(f.store.runs(f.task.id).filter(run => run.role === 'revision').length, 1, 'the identical failure spends no second author turn');
  } finally { await f.close(); }
});

/**
 * Task 394: the incident shape is a task whose author returned the identical
 * reviewed head after one failed-check refusal, and whose merge gate then
 * observed the same failed job again. That observation bought another author
 * turn and another reviewer turn every round until the budget ran out, so
 * nothing the owner could see explained the repeated cycles. The loop is
 * proved here on the real lifecycle: review, gate, revision return, gate.
 */
for (const reportedHead of ['', head, 'd'.repeat(40)]) {
  test(`an optional report head (${reportedHead || 'missing'}) and an intervening reviewer cannot buy another identical refusal round`, async () => {
    const f = fixture();
    try {
      const runs = (code: number) => `https://github.com/example/repo/actions/runs/${code}/job/1`;
      const failure = (code: number) => `PR checks failed: qa (job URL: ${runs(code)})`;
      let wait = failure(9);
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait, checksFailed: Boolean(wait), checksPolicy: 'all'}) as never;
      const accepted: Completion = {taskId: f.task.id, runId: 'retained-review', eventId: 'retained-approval', status: 'ready_to_merge', summary: 'Approved exact head', head, reviewCommentId: 1};
      const reviewer = profile('retained-reviewer');
      f.store.putRun(runSchema.parse({id: accepted.runId, taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
        profile: reviewer, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: accepted, released: true}));
      f.store.update(f.task.id, {skipPRReview: true, resolution: {...f.current().resolution, review: accepted, reviewerAgentId: 'worker', reviewerProfile: reviewer}});
      await stepEngine(f.engine);
      assert.equal(accepted.status, 'ready_to_merge');
      for (let round = 0; round < 4 && f.current().phase !== 'changes_requested'; round++) await stepEngine(f.engine);
      assert.equal(f.current().phase, 'changes_requested', JSON.stringify({phase: f.current().phase, reason: f.current().reason}));
      assert.match(f.current().reason, /qa \(job URL: /, 'the failure is fully visible');
      assert.equal(f.current().resolution.revisionRuns, 0, 'the refusal itself spends no round');
      await f.engine.wake();
      const firstRevision = f.run();
      assert.equal(firstRevision.role, 'revision');
      assert.equal(firstRevision.instruction, failure(9), 'the author receives the exact failed check');
      assert.equal(firstRevision.revisionCause, 'pre_merge');
      assert.equal(f.current().resolution.revisionRuns, 0, 'a refusal continues the open round without consuming a review round');

      // The author returns the unchanged head, so the same bytes carry the same
      // check evidence. The accepted review must survive; another reviewer would
      // read identical source. The same quantum re-observes the gate, so the
      // return lands directly in the planner park rather than another cycle.
      // Hold the first post-return gate observation so the evidence-only review
      // can settle between the unchanged author return and the repeated refusal.
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: 'Waiting for the next exact-head gate observation'}) as never;
      await f.report('ready_for_review', true, reportedHead);
      assert.equal(f.current().resolution.review?.eventId, accepted.eventId, 'the accepted exact-head review survives the unchanged return');
      assert.equal(f.store.runs(f.task.id).filter(run => run.role === 'revision').length, 1);
      assert.equal(f.creates.filter(run => run.role === 'reviewer').length, 0, 'no fresh reviewer is dispatched for unchanged source');
      assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'unchanged_check_revision'));

      // A later evidence-only review can become the task's latest completion
      // before the gate is observed again. The author revision remains the
      // evidence that bought this round, even though completion now names review.
      const reReview: Completion = {taskId: f.task.id, runId: 'evidence-rereview', eventId: 'evidence-rereview-result', status: 'ready_to_merge', summary: 'Evidence-only re-review; no new delta', head, prNumber: 1, reviewCommentId: 2};
      f.store.putRun(runSchema.parse({id: reReview.runId, taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
        profile: reviewer, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: reReview, released: true}));
      f.store.update(f.task.id, {completion: reReview, resolution: {...f.current().resolution, review: reReview}});
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait, checksFailed: Boolean(wait), checksPolicy: 'all'}) as never;

      // The same failed job at the same head is the fact that already bought one
      // round: it parks with one planner escalation and still blocks merge.
      await f.engine.wake();
      assert.ok(['escalated', 'operator_needed'].includes(f.current().resolution.stop?.reason ?? ''), 'the unchanged refusal remains parked in planner escalation');
      assert.match(f.current().reason, /Waiting with the planner/);
      assert.equal(f.counts().merges, 0, 'the failed check still blocks merge');
      assert.equal(f.current().resolution.review?.eventId, reReview.eventId, 'the intervening re-review is accepted at the same head');
      assert.equal(f.current().resolution.revisionRuns, 0, 'the identical observation spends no semantic round');
      assert.equal(f.store.runs(f.task.id).filter(run => run.role === 'revision').length, 1, 'no automatic author cycle on unchanged evidence');
      assert.equal(f.creates.filter(run => run.role === 'reviewer').length, 0, 'no automatic reviewer cycle on unchanged evidence');
      assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'pre_merge_refused').length, 1);
      assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'unchanged_check_revision_refused'));
      assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'planner_escalation').length, 1);
      const escalation = f.store.eventsAll(f.task.id).find(event => event.kind === 'planner_escalation_payload')!.detail;
      assert.ok(escalation.includes('qa') && escalation.includes(job) && escalation.includes(head) && escalation.includes('without a source change'));
      assert.deepEqual(f.reruns, [], 'nothing reran hosted CI');
      await f.engine.wake();
      assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'planner_escalation').length, 1, 'the parked refusal reuses its escalation');
      assert.equal(f.store.runs(f.task.id).filter(run => run.role === 'revision').length, 1);
      wait = '';
      for (let round = 0; round < 10 && f.counts().merges === 0; round++) await f.engine.wake();
      assert.equal(f.counts().merges, 1, 'a later passing gate merges on the retained approval: '+f.current().phase+' '+f.current().reason);
      assert.equal(f.current().resolution.review?.eventId, reReview.eventId);
      assert.equal(f.creates.filter(run => run.role === 'reviewer').length, 0);
    } finally { await f.close(); }
  });
}

test('every pre-merge refusal parks on its second unchanged observation regardless of report shape', async () => {
  for (const reason of [
    'GitHub reports a merge conflict; the worker must update the PR head',
    'Repository pre-merge refusal at the reviewed head: policy denied',
    'Repository pre-merge refusal at the prospective merge: policy denied',
    'Prospective merge conflict: unresolved conflict',
    'Project validation refused the prospective merge: validation failed',
  ]) {
    const f = fixture();
    try {
      await stepEngine(f.engine);
      await f.report('ready_to_merge', false);
      // Exercise the shared refusal boundary used by conflicts and repository
      // hooks, without fabricating a different hook execution for every shape.
      const route = f.engine.resolution as unknown as {refusePreMerge(t: Task, reason: string, detail: string): void};
      route.refusePreMerge(f.current(), reason, reason);
      await f.engine.wake();
      const revision = f.run();
      assert.equal(revision.role, 'revision');
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: 'Hold for test observation'}) as never;
      await f.report('ready_for_review', true, '');
      // Even a report with no usable completion fields cannot weaken observed
      // head evidence. Reviewer completion may now own task.completion.
      f.store.putRun({...f.store.run(revision.id)!, completion: null});
      // Automatic unfinished/non-delivery continuations remain in this round.
      for (const revisionCause of ['unfinished', 'non_delivery'] as const) {
        f.store.putRun({...f.store.run(revision.id)!, id: randomUUID(), revisionCause,
          instruction: 'Continue the approved task', createdAt: new Date().toISOString()});
      }
      route.refusePreMerge(f.current(), reason, reason);
      assert.equal(f.current().resolution.stop?.reason, 'escalated', reason);
      assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'pre_merge_refused').length, 1);
      const count = f.store.runs(f.task.id).length;
      await f.engine.wake();
      assert.equal(f.store.runs(f.task.id).length, count, 'parking creates no further runs');
      assert.equal(f.counts().merges, 0);
    } finally { await f.close(); }
  }
});

test('alternating refusals at one head each get one round, then an earlier refusal parks', async () => {
  const f = fixture();
  try {
    await stepEngine(f.engine);
    await f.report('ready_to_merge', false);
    f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: 'Hold for test observation'}) as never;
    const route = f.engine.resolution as unknown as {refusePreMerge(t: Task, reason: string, detail: string): void};
    for (const reason of ['Refusal A', 'Refusal B']) {
      route.refusePreMerge(f.current(), reason, reason);
      assert.equal(f.current().phase, 'changes_requested');
      for (let step = 0; step < 4 && !f.run(); step++) await f.engine.wake();
      assert.equal(f.run()?.role, 'revision', f.current().phase + ': ' + f.current().reason);
      await f.report('ready_for_review', true, '');
      for (let step = 0; step < 4 && f.current().phase === 'awaiting_review'; step++) await f.engine.wake();
      if (f.run()?.role === 'reviewer') await f.report('ready_to_merge');
    }
    route.refusePreMerge(f.current(), 'Refusal A', 'Refusal A');
    assert.equal(f.current().resolution.stop?.reason, 'escalated');
    const count = f.store.runs(f.task.id).length;
    await f.engine.wake();
    assert.equal(f.store.runs(f.task.id).length, count);
    assert.equal(f.store.runs(f.task.id).filter(run => run.role === 'revision').length, 2);
    assert.equal(f.counts().merges, 0);
  } finally { await f.close(); }
});

test('a changed failed check returns to the author with the retained review intact', async () => {
  const f = fixture();
  try {
    const failure = (code: number) => `PR checks failed: qa (job URL: https://github.com/example/repo/actions/runs/${code}/job/1)`;
    let wait = failure(9);
    f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait, checksFailed: Boolean(wait), checksPolicy: 'all'}) as never;
    const accepted: Completion = {taskId: f.task.id, runId: 'retained-review', eventId: 'retained-approval', status: 'ready_to_merge', summary: 'Approved exact head', head, reviewCommentId: 1};
    const reviewer = profile('retained-reviewer');
    f.store.putRun(runSchema.parse({id: accepted.runId, taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'worker', workspaceId: 'workspace',
      profile: reviewer, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: accepted, released: true}));
    f.store.update(f.task.id, {skipPRReview: true, resolution: {...f.current().resolution, review: accepted, reviewerAgentId: 'worker', reviewerProfile: reviewer}});
    await f.engine.wake();
    for (let round = 0; round < 4 && f.current().phase !== 'changes_requested'; round++) await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested');
    await f.engine.wake();
    assert.equal(f.run().role, 'revision');

    wait = failure(10);
    await f.report('ready_for_review');
    for (let round = 0; round < 4 && f.current().phase !== 'changes_requested'; round++) await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested');
    await f.engine.wake();
    assert.equal(f.run().role, 'revision');
    assert.equal(f.run().instruction, failure(10), 'different check identity takes the ordinary revision path');
    assert.equal(f.current().resolution.review?.eventId, accepted.eventId, 'the exact-head approval remains retained');
    assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'planner_escalation').length, 0);

  } finally { await f.close(); }
});

test('an owner instruction after a failed check is freshly evaluated, never parked on stale evidence', async () => {
  const f = fixture();
  try {
    const failed = `PR checks failed: qa (job URL: ${job})`;
    f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: failed, checksFailed: true}) as never;
    await stepEngine(f.engine);
    await f.report('ready_to_merge', false);
    await stepEngine(f.engine);
    for (let round = 0; round < 4 && f.current().phase !== 'changes_requested'; round++) await stepEngine(f.engine);
    assert.equal(f.current().phase, 'changes_requested');
    // An owner instruction replaces the gate text as the author's action, so the
    // unchanged head is no longer the same evidence: the ordinary path runs.
    const moved = await f.engine.performTaskControl({taskId: f.task.id, version: f.current().version, action: 'move', to: 'work', reason: 'Fix the failing check at source', instruction: 'Rerun the failed check locally and fix the cause'});
    assert.equal(moved.phase, 'changes_requested');
    await f.engine.wake();
    assert.equal(f.run().instruction, 'Rerun the failed check locally and fix the cause');
    await f.report('ready_for_review');
    for (let round = 0; round < 4 && f.run()?.role !== 'reviewer'; round++) await f.engine.wake();
    assert.equal(f.run().role, 'reviewer', 'the owner-directed return takes the ordinary review path');
    assert.equal(f.current().resolution.attention, false, 'an owner instruction is not the no-progress shape');
    assert.ok(!f.store.eventsAll(f.task.id).some(event => event.kind === 'unchanged_check_revision_refused'));
    assert.equal(f.current().resolution.revisionRuns, 0, 'an administrative owner instruction spends no semantic round');
    await f.report('ready_to_merge');
    for (let round = 0; round < 4 && f.current().phase !== 'changes_requested'; round++) await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested', 'the failed check still refuses into the ordinary revision budget');
    assert.equal(f.current().resolution.attention, false);
  } finally { await f.close(); }
});

test('uncertain-merge recovery applies the current exact-head gates before the one guarded re-issue', async () => {
  for (const outcome of ['refuses', 'pending'] as const) {
    const f = fixture(60_000);
    try {
      const merge = f.adapter.merge!;
      let requests = 0;
      f.adapter.merge = async (t, allowed) => { requests++; await merge(t, allowed); if (requests === 1) throw new Error('Response lost'); };
      f.adapter.merged = async t => ({merged: false, commit: null, head: t.prHead!, base: 'main',
        proof: {proven: true, detail: 'exact open unmerged PR; no auto-merge or queue entry'}});
      let gates = 0;
      const refusing = (t: Task) => outcome === 'refuses'
        ? {head: t.prHead!, base, wait: `PR checks failed: qa (job URL: ${job})`, checksFailed: true} as never
        : {head: t.prHead!, base, wait: 'PR checks are pending', pendingCheck: true} as never;
      await f.engine.wake();
      await f.report('ready_to_merge');
      for (let round = 0; round < 6 && f.current().phase !== 'merging'; round++) await f.engine.wake();
      assert.equal(f.counts().merges, 1);
      assert.equal(f.current().resolution.mergeIntent, true);
      // The recorded intent is unmerged and the continuous non-merge proof has
      // matured: the re-issue must consult current policy and requirements.
      f.adapter.mergeGate = async t => { gates++; return refusing(t); };
      f.store.update(f.task.id, {resolution: {...f.current().resolution, mergeProofSince: new Date(Date.now() - 61_000).toISOString()}});
      const gatesBefore = gates;
      await f.engine.wake();
      assert.equal(f.counts().merges, 1, `${outcome}: no re-issue behind a gate that does not pass`);
      assert.ok(gates > gatesBefore, `${outcome}: the recovery path observes the exact-head gates`);
      assert.equal(f.current().resolution.mergeRetryAt, null, `${outcome}: the retry fence is not spent`);
      assert.equal(f.current().resolution.mergeRetryOutcome, null);
      if (outcome === 'refuses') {
        assert.equal(f.current().phase, 'needs_attention');
        assert.match(f.current().reason, /current exact-head gates refuse the guarded re-issue.*qa/);
      } else {
        assert.equal(f.current().phase, 'merging');
        assert.match(f.current().reason, /guarded re-issue waits for current exact-head gates/);
        assert.equal(f.current().resolution.mergeIntent, true, 'the uncertainty fence is preserved');
      }
      // A passing gate still gets its one bounded re-issue.
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: '', checksPolicy: 'all'} as never);
      if (outcome === 'pending') {
        await f.engine.wake();
        assert.equal(f.counts().merges, 2);
        assert.equal(f.current().resolution.mergeRetryOutcome, 'accepted');
      }
    } finally { await f.close(); }
  }
});

test('a guarded re-issue never sends when the integration base moved past the verified candidate', async () => {
  const moved = 'd'.repeat(40);
  for (const origin of ['lost-response', 'withdrawn-send'] as const) {
    const f = fixture(60_000);
    try {
      f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
      const merge = f.adapter.merge!;
      let requests = 0;
      f.adapter.merge = async (t, allowed) => {
        requests++;
        if (requests === 1 && origin === 'withdrawn-send') {
          // A late policy write withdraws the first send; the intent remains.
          f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'all'});
          assert.equal(allowed!(), false);
          throw new Error('Paused before merge request');
        }
        await merge(t, allowed);
        if (requests === 1) throw new Error('Response lost');
      };
      f.adapter.merged = async t => ({merged: false, commit: null, head: t.prHead!, base: 'main',
        proof: {proven: true, detail: 'exact open unmerged PR; no auto-merge or queue entry'}});
      f.adapter.mergeGate = async t => ({head: t.prHead!, base, wait: '', checksPolicy: 'required', requirements: {known: true, required: 0}, advisory: []}) as never;
      await f.engine.wake();
      await f.report('ready_to_merge');
      for (let round = 0; round < 6 && f.current().resolution.mergeResponseOutcome !== 'uncertain'; round++) await f.engine.wake();
      assert.equal(f.current().resolution.mergeIntent, true, origin);
      assert.equal(f.current().resolution.mergeBase, base, origin);
      const sentBefore = f.counts().merges;
      assert.equal(sentBefore, origin === 'withdrawn-send' ? 0 : 1, origin);
      // The proof window has matured, but the fresh gate reports a new base for
      // the same reviewed head: the old candidate's verification does not cover it.
      f.adapter.mergeGate = async t => ({head: t.prHead!, base: moved, wait: '', checksPolicy: 'all'}) as never;
      f.store.update(f.task.id, {resolution: {...f.current().resolution, mergeProofSince: new Date(Date.now() - 61_000).toISOString()}});
      await f.engine.wake();
      assert.equal(f.counts().merges, sentBefore, `${origin}: no request is sent for an unverified candidate`);
      assert.equal(f.current().resolution.mergeRetryAt, null, `${origin}: no retry intent is recorded`);
      assert.equal(f.current().resolution.mergeIntent, true, `${origin}: the durable intent is kept for inspection`);
      assert.equal(f.current().phase, 'needs_attention', origin);
      assert.ok(f.current().resolution.integrationTurn, `${origin}: unresolved merge intent retains the turn`);
      assert.match(f.current().reason, new RegExp(`integration base is ${moved}.*for ${base}`));
      assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'merge_retry_intent').length, 0, origin);
    } finally { await f.close(); }
  }
});

test('a policy change is revalidated on the waiting poll and merges the waiting task without replaying history', async () => {
  const f = fixture();
  try {
    f.store.update(f.task.id, {skipPRReview: true});
    let advisory = false, seenPolicy = '';
    const observation = (t: Task) => advisory
      ? {head: t.prHead!, base, wait: '', checksPolicy: 'required', requirements: {known: true, required: 0},
         advisory: [{identity: 'CheckRun', name: 'macos-gateway', state: 'COMPLETED', conclusion: 'FAILURE', jobUrl: job}]}
      : {head: t.prHead!, base, wait: 'PR checks are pending', pendingCheck: true, checksPolicy: 'all'};
    f.adapter.mergeGate = async (t, _history, _reviewer, policy) => { seenPolicy = String(policy); return observation(t) as never; };
    f.adapter.requiredChecks = async (t, _history, policy) => { seenPolicy = String(policy); return observation(t) as never; };
    await f.engine.wake();
    assert.equal(f.counts().merges, 0);
    assert.equal(f.current().phase, 'merging');
    assert.ok(f.current().resolution.integrationTurn, 'a pending check keeps its FIFO sequence while yielding');
    assert.equal(seenPolicy, 'all');
    // The operator turns the repository advisory while the task waits. The next
    // poll re-reads the policy and GitHub's requirements for the exact head.
    f.store.patchRepository({origin: null, path: '/repo'}, {checksPolicy: 'required'});
    advisory = true;
    const pollKey = `requiredCheckPoll:${f.task.id}:${head}`;
    const state = f.store.getMeta<{head: string; nextAt: number}>(pollKey)!;
    f.store.setMeta(pollKey, {...state, nextAt: 0});
    for (let round = 0; round < 8 && f.counts().merges === 0; round++) await f.engine.wake();
    assert.equal(seenPolicy, 'required', 'the waiting poll re-reads the changed policy');
    assert.equal(f.counts().merges, 1, 'the waiting task merges once the policy makes its check advisory: '+f.current().phase+' '+f.current().reason);
    assert.equal(f.creates.filter(run => run.role === 'revision').length, 0);
    assert.equal(f.store.getMeta(pollKey), undefined, 'the settled wait is cleared');
    assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'pre_merge_refused').length, 0, 'no author return is replayed');
  } finally { await f.close(); }
});
