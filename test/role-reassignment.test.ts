import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, taskControlInputSchema, type Profile, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { runPrompt } from '../core/dispatch/prompts';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const profile = (id: string, model: string, roles: Array<'worker' | 'reviewer'> = ['worker'], group?: string): { profile: Profile; entry: { profileId: string; enabled: boolean; group: string; roles: Array<'worker' | 'reviewer'>; weight: number; scopes: Array<'general'> } } => ({
  profile: { id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [] },
  entry: { profileId: id, enabled: true, group: group ?? id, roles, weight: 1, scopes: ['general'] },
});
// Spec 036 acceptance shape: Sol writes, a fresh Luna agent reviews. `author`
// is the retained worker, `authorrev` is a reviewer route on the author's
// model, `fresh` keeps automatic selection honest.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-reassign-')), store = new Store(join(dir, 'queue.sqlite'));
  const author = profile('author', 'author', ['worker', 'reviewer']);
  const sol = profile('sol', 'sol');
  const luna = profile('luna', 'luna', ['reviewer']);
  const fresh = profile('fresh', 'fresh', ['reviewer']);
  const authorrev = profile('authorrev', 'author', ['reviewer']);
  const all = [author, sol, luna, fresh, authorrev];
  store.setMeta('paused', false);
  store.setMeta('pool', all.map(item => item.entry));
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  // Between runs with an unmerged PR: the retained-worker replacement path applies.
  const task = store.update(submitted.id, { phase: 'needs_attention', reason: 'Revision budget exhausted; coordinator judgment required', workspaceId: 'workspace', directory: '/worktree', agentId: 'worker', runId: 'initial', profile: author.profile, workerModel: author.profile.model, workerModels: [author.profile.model], prHead: head, prUrl: 'https://github.com/example/repo/pull/1', completion: { taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1 } });
  const states = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string; provider?: string; model?: string }>();
  const idle = (id: string, workspaceId = 'workspace') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: store.runs(task.id).findLast(run=>run.agentId===id)?.profile?.model??(id==='luna-agent-1'?'luna':'author') });
  idle('worker'); idle('luna-agent-1');
  const tokens = new Map<string, string>(), creates: Run[] = [], prompts: string[] = [], workerPrompts: string[] = [];
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => all.map(item => item.profile),
    validate: async () => base, verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error('No workspace creation in reassignment'); },
    createAgent: async (t, token, mcpPrompt) => {
      tokens.set(t.runId!, token); workerPrompts.push(String(mcpPrompt));
      const id = t.profile!.id === 'sol' ? 'sol-worker' : `agent-${t.profile!.id}`;
      states.set(id, { id, workspaceId: t.workspaceId!, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: t.workspaceId! };
    },
    observe: async id => { const s = states.get(id); if (!s) throw new Error('Agent missing'); return s as never; },
    verifyPr: async () => ({ head, url: task.prUrl! }), verifyPrIdentity: async () => ({ head, url: task.prUrl! }), verifyCleanQueueWorktree: async () => {},
    verifyResume: async () => {},
    createRun: async (t, r, token) => {
      creates.push(r); tokens.set(r.id, token);
      prompts.push(runPrompt(t, r, '/helper', '/ticket', true));
      const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: r.workspaceId };
    },
    sendRun: async (t, r, token) => { prompts.push(runPrompt(t, r, '/helper', '/ticket', true)); tokens.set(r.id, token); },
    findRunAgents: async () => [],
    verifyReview: async () => {}, mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all.map(item => item.profile);
  const current = () => store.task(task.id);
  return { store, engine, adapter, task, current, states, idle, tokens, creates, prompts, workerPrompts, dir, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}


test('retired verifier history is not authorship; ordinary authorized review retains its own independent agent', async () => {
  const f = fixture(); try {
    const reviewer = f.engine.profiles.find(p => p.id === 'luna')!;
    f.store.putRun({ id: 'old-verifier', taskId: f.task.id, role: 'reviewer', generation: 1, head, base, agentId: 'luna-agent-1', workspaceId: 'workspace', profile: reviewer, status: 'superseded', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: true });
    const history = (run: Run) => JSON.stringify({ id: run.id, role: run.role, agentId: run.agentId, head: run.head, profile: run.profile, status: run.status, released: run.released, completion: run.completion });
    const before = history(f.store.run('old-verifier')!);
    f.store.update(f.task.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution, reviewerAgentId: 'luna-agent-1', reviewerProfile: reviewer } });
    assert.ok(!f.engine.resolution.authorAgentIds(f.current()).has('luna-agent-1'));
    await f.engine.wake();
    const run = f.store.runs(f.task.id).find(r => r.id !== 'old-verifier' && r.role === 'reviewer');
    assert.ok(run);
    assert.equal(run.agentId, 'luna-agent-1');
    assert.equal(f.creates.length, 0, 'no fresh agent loses the retained independent reading context');
    assert.equal(history(f.store.run('old-verifier')!), before, 'stopped result and identity are unchanged; observation telemetry may refresh');
  } finally { await f.close(); }
});


test('036-6 automatic reviewer selection still excludes every author model', async () => {
  const f = fixture(); try {
    f.store.update(f.task.id, { phase: 'awaiting_review', profile: f.engine.profiles.find(p => p.id === 'sol')!, workerModel: 'sol', workerModels: ['author', 'luna', 'sol'] });
    const selection = f.engine.resolution.select(f.current(), 'reviewer');
    assert.ok(selection, 'an automatic reviewer exists');
    assert.equal(selection.profile.id, 'fresh', 'automatic selection never falls back to an earlier author model');
  } finally { await f.close(); }
});


