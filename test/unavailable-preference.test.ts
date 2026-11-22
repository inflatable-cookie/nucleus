import { reconcileUnavailablePreference } from "../core/dispatch/unavailable-preference";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Decisions } from '../core/planning/decisions';
import { poolSchema, submissionSchema, taskControlInputSchema, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';

const profile = (id: string): Profile => ({ id, name: id === 'sol' ? 'Sol oracle' : id, provider: 'test', model: `test/${id}`, available: true, problem: '', notes: '', supportedThinking: id === 'opus' ? ['xhigh'] : [] });
const profiles = ['cheap', 'sol', 'opus'].map(profile);
const pool = [
  poolSchema.parse({ profileId: 'cheap', enabled: true, group: 'cheap', roles: ['worker', 'reviewer', 'coordinator'], weight: "default", scopes: ['general'], }),
  poolSchema.parse({ profileId: 'sol', enabled: true, group: 'sol', roles: ['worker', 'reviewer'], weight: "default", scopes: ['general'], capability: 'frontier' }),
  poolSchema.parse({ profileId: 'opus', enabled: true, group: 'opus', roles: ['worker', 'reviewer'], weight: "default", scopes: ['general'], capability: 'frontier' }),
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-unavailable-profile-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('pool', pool);
  const decisions = new Decisions(store);
  const submit = (extra: Record<string, unknown> = {}) => store.insert(submissionSchema.parse({ submissionId: `routing-${Math.random()}`, title: 'Required profile task',
    repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'planner',
    profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } }, ...extra }), 'host', 'handoff', 'a'.repeat(40));
  const reconcile = (id: string) => reconcileUnavailablePreference(store, decisions, store.task(id), profiles);
  const answer = (id: string, text: string, relayed = false) => {
    const decision = decisions.get({ id });
    return decisions.answer({ id, version: decision.version, answer: text, answeredBy: relayed ? 'supervisor' : 'operator (board)', relayed, note: relayed ? 'Tom said yes' : '' });
  };
  return { dir, store, decisions, submit, reconcile, answer, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a missing required preference asks for a new route', () => {
  const f = fixture(); try {
    const task = f.submit({ profileRequests: {}, preferredProfileId: 'missing', requirePreferred: true });
    f.reconcile(task.id);
    const decision = f.decisions.list({ task: task.id })[0]!;
    assert.match(decision.question, /missing, disabled or unavailable/);
    f.reconcile(task.id);
    assert.equal(f.decisions.list({ task: task.id }).length, 1);
    f.answer(decision.id, 'Use cheap');
    f.reconcile(task.id);
    const request = f.store.task(task.id).profileRequests!.worker!;
    assert.equal(request.profileId, 'cheap');
  } finally { f.close(); }
});

test('a disabled required preference surfaces a routing decision', () => {
  const f = fixture(); try {
    f.store.setMeta('pool', pool.map(entry => entry.profileId === 'cheap' ? { ...entry, enabled: false } : entry));
    const task = f.submit({ profileRequests: {}, preferredProfileId: 'cheap', requirePreferred: true });
    f.reconcile(task.id);
    assert.match(f.decisions.list({ task: task.id })[0]!.question, /missing, disabled or unavailable/);
  } finally { f.close(); }
});

test('changing or clearing a required preference withdraws its old routing question', async () => {
  for (const replacement of ['cheap', '']) {
    const f = fixture(); const engine = new Engine(f.store, {} as Adapter, 0); engine.profiles = profiles;
    try {
      const task = f.submit({ profileRequests: {}, preferredProfileId: 'missing', requirePreferred: true, skipPRReview: true });
      f.reconcile(task.id);
      const decision = f.decisions.list({ task: task.id })[0]!;
      await engine.performTaskControl(taskControlInputSchema.parse({ action: 'set_routing', taskId: task.id,
        version: f.store.task(task.id).version, preferredProfileId: replacement, requirePreferred: Boolean(replacement),
        reason: 'Change preference', caller: 'operator (board)' }));
      f.reconcile(task.id);
      assert.notEqual(f.decisions.get({ id: decision.id }).status, 'open');
      assert.equal(f.store.task(task.id).preferredProfileId, replacement);
    } finally { await engine.stop(); f.close(); }
  }
});
