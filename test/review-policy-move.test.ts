import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewPolicy, type ReviewPolicyHost } from '../core/review/review-policy';
import type { ReviewEntryInput, Task } from '../shared/contracts';

test('registration and review entry read current host seams in their original order', async () => {
  const calls: string[] = [];
  const agent = { workspaceId: 'ws', archivedAt: null, refresh: async () => { calls.push('agent refresh'); }, current: () => ({ labels: {} }) };
  const workspace = { directory: '/work', refresh: async () => { calls.push('workspace refresh'); }, current: () => ({ projectRootPath: '/repo' }) };
  const host = {
    messageHost: { retainedAgentRef: () => agent },
    workspaceHost: { workspaceRef: () => workspace, activeThreads: async () => { calls.push('inventory'); return []; } },
    originAgent: async () => { calls.push('origin'); return { id: 'author', workspaceId: 'ws', archived: false }; },
    observe: async () => { calls.push('observe'); return { id: 'author', workspaceId: 'ws', status: 'idle', active: false, permissions: false }; },
  } as unknown as ReviewPolicyHost;
  const policy = new ReviewPolicy(host);
  await policy.inspectRegistration('author');
  assert.deepEqual(calls, ['agent refresh', 'workspace refresh', 'observe']);
  calls.length = 0;
  // Queue #912: a review-entry origin observation must name the origin thread and its workspace.
  await policy.inspectReviewEntry({ workspaceId: 'ws', submission: { repoPath: '/repo', originAgentId: 'author' } } as unknown as ReviewEntryInput);
  assert.deepEqual(calls, ['workspace refresh', 'origin', 'observe', 'inventory']);
  host.observe = async () => { calls.push('replacement'); return { id: 'author', workspaceId: 'ws', status: 'idle', active: false, permissions: false } as never; };
  calls.length = 0;
  await policy.inspectReviewEntry({ workspaceId: 'ws', submission: { repoPath: '/repo', originAgentId: 'author' } } as unknown as ReviewEntryInput);
  assert.deepEqual(calls, ['workspace refresh', 'origin', 'replacement', 'inventory']);
});

test('worker continuation uses the latest preflight and sends only after binding', async () => {
  const calls: string[] = [];
  let sent = '';
  const host = {
    helperPath: '/nucleus/worker-report.mjs',
    preflightWorkerContinuation: async () => { calls.push('preflight'); return { available: true }; },
    messageHost: { retainedAgentRef: () => ({ workspaceId: 'ws', archivedAt: null, refresh: async () => { calls.push('refresh'); }, current: () => ({ labels: { 'nucleus.mcpBinding': 'old' } }), send: async (text: string) => { sent = text; calls.push('send'); } }) },
    binding: () => { calls.push('binding'); },
  } as unknown as ReviewPolicyHost;
  const policy = new ReviewPolicy(host);
  const task = { agentId: 'worker', workspaceId: 'ws', runId: 'new' } as Task;
  await policy.continueWorker(task, 'intent', 'text', () => { calls.push('issue'); return { runId: 'new', token: 'token' }; });
  assert.deepEqual(calls, ['preflight', 'refresh', 'issue', 'binding', 'send']);
  assert.match(sent, /NUCLEUS_CONTINUATION_RUN_ID=new/);
  assert.match(sent, /NUCLEUS_CONTINUATION_TICKET='\/nucleus\/tickets\/new\.json'/);
  assert.match(sent, /\n\ntext$/);
  host.preflightWorkerContinuation = async () => ({ available: false, reason: 'changed' });
  calls.length = 0;
  await assert.rejects(policy.continueWorker(task, 'intent', 'text'), /changed/);
  assert.deepEqual(calls, []);
});

test('creation guard rechecks the current native seam before invoking it', async () => {
  const { AgentPolicy } = await import('../core/dispatch/agent-policy');
  const calls: string[] = [];
  const host = { nativeAgentCreate: async () => { calls.push('create'); return { id: 'a', workspaceId: 'ws' }; } } as unknown as import('../core/dispatch/agent-policy').AgentPolicyHost;
  const policy = new AgentPolicy(host);
  const spec = { guard: { allowed: async () => { calls.push('allowed'); return true; }, stillAllowed: () => { calls.push('stillAllowed'); return true; } } } as unknown as import('../shared/host').HostAgentSpec;
  await policy.guardedNativeAgentCreate(spec, false, false);
  assert.deepEqual(calls, ['allowed', 'stillAllowed', 'create']);
  calls.length = 0;
  host.nativeAgentCreate = async () => { calls.push('replacement'); return { id: 'b', workspaceId: 'ws' }; };
  await policy.guardedNativeAgentCreate(spec, false, false);
  assert.deepEqual(calls, ['allowed', 'stillAllowed', 'replacement']);
  calls.length = 0;
  spec.guard!.stillAllowed = () => false;
  await assert.rejects(policy.guardedNativeAgentCreate(spec, false, false), /changed before creation/);
  assert.deepEqual(calls, ['allowed']);
});

test('reporting cleanup is synchronous and reads the current helper directory', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { purgeReportingFiles, reportingFallback } = await import('../core/intake/reporting-files');
  const root = mkdtempSync(join(tmpdir(), 'reporting-move-'));
  const tickets = join(root, 'tickets'); mkdirSync(tickets);
  const ticket = join(tickets, 'run.json'); writeFileSync(ticket, JSON.stringify({ taskId: 'task' }));
  const other = join(tickets, 'mcp-run.json'); writeFileSync(other, JSON.stringify({ taskId: 'other' }));
  assert.equal(purgeReportingFiles(join(root, 'helper'), 'task', ['run']), undefined);
  assert.equal(existsSync(ticket), false);
  assert.equal(existsSync(other), true);
  assert.match(reportingFallback(join(root, 'helper'), { id: 'run', head: 'head', generation: 2 } as import('../shared/contracts').Run), /head head and coordinatorGeneration 2/);
});
