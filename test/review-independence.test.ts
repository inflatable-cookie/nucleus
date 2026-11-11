import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaseoAdapter } from '../service/paseo-composition';

// Spec 036 at review verification (Project-A #1725, 2026-10-01): an operator's explicitly
// requested reviewer may share an earlier author's model. Spec 050 (Tom 2026-10-13)
// extends the owner-routed reviewer to the current author's model; the owner_control
// event records the waiver. The reviewer agent is never an author agent.
const INDEPENDENCE = /not independent/;
function adapter(models: Record<string, string>) {
  const a = Object.create(PaseoAdapter.prototype) as PaseoAdapter;
  (a as any).observe = async (id: string) => ({ model: models[id] ?? null });
  return a;
}
const task = (over: Record<string, unknown> = {}) => ({
  agentId: 'sol-worker', retiredWorkers: [{ agentId: 'luna-old' }, { agentId: 'deepseek-old' }],
  workerModels: ['deepseek/deepseek-flash', 'gpt-6-luna', 'gpt-6.1-sol'], workerModel: 'gpt-6.1-sol',
  profile: { id: 'sol', model: 'gpt-6.1-sol' },
  profileRequests: { reviewer: { profileId: 'luna', reason: 'Tom', required: true } }, ...over }) as any;
const run = (agentId: string, profile: { id: string; model: string }) => ({ id: 'r', agentId, profile, head: 'a'.repeat(40) }) as any;
const models = { 'sol-worker': 'gpt-6.1-sol', 'luna-fresh': 'gpt-6-luna', 'luna-old': 'gpt-6-luna', 'sol-fresh': 'gpt-6.1-sol', 'muse': 'muse', 'blank': '   ' };
async function independence(t: any, r: any) {
  try { await adapter(models).verifyReview(t, r, {} as any); return 'passed'; }
  catch (error) { return INDEPENDENCE.test(String(error)) ? 'refused' : 'passed'; }
}

test('an explicitly requested fresh reviewer may share an earlier author model', async () => {
  assert.equal(await independence(task(), run('luna-fresh', { id: 'luna', model: 'gpt-6-luna' })), 'passed');
});
test('an earlier author model is refused without the explicit request', async () => {
  assert.equal(await independence(task({ profileRequests: {} }), run('luna-fresh', { id: 'luna', model: 'gpt-6-luna' })), 'refused');
});
test('the current author model passes only through the owner-routed reviewer request', async () => {
  const routed = task({ profileRequests: { reviewer: { profileId: 'sol', reason: 'Tom routed it', required: true, ownerRoute: true } } });
  assert.equal(await independence(routed, run('sol-fresh', { id: 'sol', model: 'gpt-6.1-sol' })), 'passed');
  assert.equal(await independence(task({ profileRequests: {} }), run('sol-fresh', { id: 'sol', model: 'gpt-6.1-sol' })), 'refused');
});
test('a required non-route reviewer request on the current author model is refused', async () => {
  // `set_routing` and submissions also write required:true, but never the
  // owner-route marker, so they cannot waive the current author's model.
  const board = task({ profileRequests: { reviewer: { profileId: 'sol', reason: 'Board choice', required: true } } });
  assert.equal(await independence(board, run('sol-fresh', { id: 'sol', model: 'gpt-6.1-sol' })), 'refused');
  const submitted = task({ profileRequests: { reviewer: { profileId: 'sol', reason: 'Submission request', required: true } } });
  assert.equal(await independence(submitted, run('sol-fresh', { id: 'sol', model: 'gpt-6.1-sol' })), 'refused');
});
test('an optional same-model reviewer request is refused: only a required owner route waives independence', async () => {
  const optionalCurrent = task({ profileRequests: { reviewer: { profileId: 'sol', reason: 'A soft preference', required: false } } });
  assert.equal(await independence(optionalCurrent, run('sol-fresh', { id: 'sol', model: 'gpt-6.1-sol' })), 'refused');
  const optionalEarlier = task({ profileRequests: { reviewer: { profileId: 'luna', reason: 'A soft preference', required: false } } });
  assert.equal(await independence(optionalEarlier, run('luna-fresh', { id: 'luna', model: 'gpt-6-luna' })), 'refused');
});
test('an author agent is refused as reviewer whatever its model', async () => {
  assert.equal(await independence(task(), run('luna-old', { id: 'luna', model: 'gpt-6-luna' })), 'refused');
});
test('a model that never authored the task passes as before', async () => {
  assert.equal(await independence(task({ profileRequests: {} }), run('muse', { id: 'muse', model: 'muse' })), 'passed');
});

// Review entry (Spec 017): the imported head's author evidence is its recorded
// declaration and observed external authors. Absence of a Queue worker is not an
// unknown author, and an unrecorded Queue author stays unknown even though a
// reviewer's model collides with no known model.
const reviewEntryTask = (over: Record<string, unknown> = {}) => task({
  agentId: null, runId: null, retiredWorkers: [], workerModels: [], workerModel: null, profile: null, profileRequests: {},
  reviewEntry: { authorDeclaration: { models: ['xai/grok-4.6', 'xai/grok-4.7'] } }, ...over });

test('a workerless review entry verifies an independent reviewer from its declared external authors', async () => {
  assert.equal(await independence(reviewEntryTask(), run('muse', { id: 'muse', model: 'muse' })), 'passed');
});

test('an unrecorded current Queue author refuses verification even when no model collides', async () => {
  const unrecorded = reviewEntryTask({ agentId: 'unknown-model-worker' });
  assert.equal(await independence(unrecorded, run('muse', { id: 'muse', model: 'muse' })), 'refused');
  // With the same worker's model recorded, the declared authors still prove it.
  assert.equal(await independence(reviewEntryTask({ agentId: 'sol-worker', workerModel: 'gpt-6.1-sol' }), run('muse', { id: 'muse', model: 'muse' })), 'passed');
});

// A provider-qualified `provider/unknown` names no concrete model: it is opaque
// author evidence at verification, exactly as a blank route is.
test('provider-qualified unknown model keys refuse verification as opaque evidence', async () => {
  const declared = reviewEntryTask({ reviewEntry: { authorDeclaration: { models: ['provider/unknown'] } } });
  assert.equal(await independence(declared, run('muse', { id: 'muse', model: 'muse' })), 'refused');
  const recordedWorker = reviewEntryTask({ workerModels: ['provider/unknown'], workerModel: 'provider/unknown' });
  assert.equal(await independence(recordedWorker, run('muse', { id: 'muse', model: 'muse' })), 'refused');
  // The reviewer's own opaque route cannot prove independence either.
  assert.equal(await independence(reviewEntryTask(), run('unknown-reviewer', { id: 'unknown-reviewer', model: 'provider/unknown' })), 'refused');
  // A whitespace-only model is blank, not a concrete identity.
  assert.equal(await independence(reviewEntryTask({ workerModels: ['provider/   '] }), run('muse', { id: 'muse', model: 'muse' })), 'refused');
  assert.equal(await independence(reviewEntryTask(), run('blank', { id: 'blank', model: '   ' })), 'refused');
});

// The same author-evidence derivation covers prior Queue authors and the
// author-side proof executor, so verification refuses those collisions too.
test('prior Queue authors and the proof executor are author evidence at verification', async () => {
  const priorAuthor = reviewEntryTask({ retiredWorkers: [{ agentId: 'old-author', runId: 'old-run',
    profile: { id: 'old', name: 'old', provider: 'test', model: 'gpt-6-luna', notes: '', available: true, problem: '', supportedThinking: [] } }] });
  assert.equal(await independence(priorAuthor, run('luna-fresh', { id: 'luna', model: 'gpt-6-luna' })), 'refused');
  const executor = reviewEntryTask({ proofExecutions: [{ runId: 'proof-run', agentId: 'executor-agent', workspaceId: 'workspace',
    profile: { id: 'executor', name: 'executor', provider: 'test', model: 'gpt-6-luna', notes: '', available: true, problem: '', supportedThinking: [] },
    selector: 'effigy test --plan', prNumber: 1, branch: 'feature/external', head: 'a'.repeat(40), authorizedBy: { role: 'operator' as const },
    activatedAt: new Date().toISOString(), status: 'passed' as const }] });
  assert.equal(await independence(executor, run('luna-fresh', { id: 'luna', model: 'gpt-6-luna' })), 'refused');
});

// A retained owner-revision receipt without any observation names a later
// contributor whose model is unknown, never an absent contributor.
test('an owner revision without an observation is unknown author evidence at verification', async () => {
  const unobserved = reviewEntryTask({ resolution: { externalOwnerRevisions: [{ actor: { role: 'project_owner' } }] } });
  assert.equal(await independence(unobserved, run('muse', { id: 'muse', model: 'muse' })), 'refused');
  // A relay receipt with no source observation is the same unknown contributor.
  const relay = reviewEntryTask({ resolution: { externalOwnerRevisions: [{ actor: { role: 'authorized_relay' } }] } });
  assert.equal(await independence(relay, run('muse', { id: 'muse', model: 'muse' })), 'refused');
});
