import { profile } from './fakes';
import { mkdtempSync, rmSync } from 'node:fs';
import { whileReaderInTurn } from './reader-in-turn';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../core/store/store';
import { Engine } from '../../core/engine';
import type { ResolutionAdapter } from '../../core/resolution';
import { PaseoAdapter, type Adapter, type AgentObservation } from '../../service/paseo-composition';
import { runSchema, submissionSchema, taskControlInputSchema, type Profile, type Run, type Task } from '../../shared/contracts';
import { ownerRevisionFixture } from './review-entry-fixture';
import { toolTimelinePage } from './tool-timeline';

/**
 * The retained-review continuation fixture family.
 *
 * The owner-restart and `move to=review` scenarios share one store, engine,
 * adapter and checkpoint lifecycle; one physical test file cannot hold every
 * real-Git placement scenario inside the per-file budget, so the shared shape
 * lives here and the ordinary continuation and the placement scenarios read it
 * from their own physical files.
 */

export const head = 'a'.repeat(40), base = 'b'.repeat(40), otherHead = 'c'.repeat(40);
export { profile } from './fakes';

export function fixture(options: { briefText?: string; realSource?: boolean } = {}) {
  const source = options.realSource ? ownerRevisionFixture() : null;
  const head = source?.oldHead ?? 'a'.repeat(40), base = source?.planningCommit ?? 'b'.repeat(40);
  const dir = source?.root ?? mkdtempSync(join(tmpdir(), 'ns-review-continuation-'));
  const store = source?.store ?? new Store(join(dir, 'queue.sqlite'));
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer');
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Reviewer continuation', repoPath: source?.repo ?? '/repo', planningCommit: base,
    ...(options.briefText ? { brief: { text: options.briefText, mediaType: 'text/markdown' } } : { handoffPath: 'handoff.md' }), originAgentId: 'origin' }),
  'host', options.briefText ?? 'handoff', base);
  store.update(submitted.id, {
    phase: 'reviewing', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: source?.workspace ?? '/worktree', ...(source ? { branch: 'feature/external' } : {}),
    agentId: 'worker', runId: 'worker-run', profile: worker, workerModel: worker.model, prHead: head,
    prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: submitted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  }, 'dispatched');
  const runId = 'review-run';
  store.putRun(runSchema.parse({
    id: runId, taskId: submitted.id, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: reviewer, status: 'running', createdAt: new Date().toISOString(),
    briefVersion: submitted.briefVersions.at(-1)?.version ?? null, lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
  }));
  store.setCredential(runId, 'token');
  store.update(submitted.id, { resolution: { ...store.task(submitted.id).resolution, currentRunId: runId, reviewerAgentId: 'review-agent', reviewerProfile: reviewer } });

  const continuations: { run: Run; messageId: string; text: string }[] = [];
  const reviewerDeliveries: { runId: string; messageId: string; text: string }[] = [];
  const reviewerTimeline: { timestamp: string; item: Record<string, unknown> }[] = [];
  const states = new Map<string, AgentObservation>([
    ['worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: worker.model }],
    ['review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: reviewer.model }],
  ]);
  let merges = 0, syncs = 0, deliveryMode: 'ok' | 'lost-visible' | 'lost-unknown' | 'refused-before-send' = 'ok';
  let verifyBarrier: (() => Promise<void>) | null = null;
  const createdRuns: Run[] = [];
  const adapter = {
    profiles: async () => [worker, reviewer], validate: async () => base,
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => states.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    archiveAgent: async () => {}, notify: async () => {}, findRunAgents: async () => [],
    verifyPr: async () => {
      // Race the reserved delivery's exact-head proof, independent of how many
      // fresh admission reads a caller needs before it can reserve anything.
      if (verifyBarrier && store.run(runId)?.reviewDeliveries?.some(item => item.status === 'reserved')) {
        const barrier = verifyBarrier; verifyBarrier = null; await barrier();
      }
      return { url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head };
    },
    verifyPrIdentity: async () => ({ url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head }),
    coveringEvidence: async (t: Task) => ({ head: t.prHead!, base: t.resolution.mergeBase ?? t.planningBase, wait: '' }),
    verifyCleanQueueWorktree: async () => {}, verifyReview: async () => {},
    mergeGate: async () => ({ head: store.task(submitted.id).prHead ?? head, base, wait: '' }), merge: async () => { merges++; },
    merged: async () => ({ merged: merges > 0, commit: merges > 0 ? otherHead : null, head, base: 'main' }),
    syncMain: async () => { syncs++; return otherHead; }, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); store.setCredential(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); store.setCredential(r.id, token); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }); },
    continueRun: async (r: Run, messageId: string, text: string) => { continuations.push({ run: r, messageId, text }); },
    continueReviewer: async (_task: Task, r: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean) => {
      const before = states.get(r.agentId!)!;
      if (before.status !== 'idle' || before.active || before.permissions) return { sent: false as const, reason: 'reviewer not idle' };
      if (!await allowed()) return { sent: false as const, reason: 'authorization changed' };
      const after = states.get(r.agentId!)!;
      if (after.status !== 'idle' || after.active || after.permissions || after.workspaceId !== r.workspaceId ||
          after.provider !== r.profile?.provider || after.model !== r.profile?.model ||
          (r.profile?.modeId !== undefined && after.modeId !== r.profile.modeId) ||
          (r.profile?.thinkingOptionId !== undefined && after.thinkingOptionId !== r.profile.thinkingOptionId) || !stillAllowed()) return { sent: false as const, reason: 'reviewer or task fence changed' };
      if (deliveryMode === 'refused-before-send') {
        deliveryMode = 'ok';
        return { sent: false as const, reason: 'test transport refused before messaging' };
      }
      reviewerDeliveries.push({ runId: r.id, messageId, text });
      if (deliveryMode !== 'lost-unknown') reviewerTimeline.push({ timestamp: new Date().toISOString(), item: { type: 'user_message', messageId, text } });
      if (deliveryMode !== 'ok') throw new Error('Paseo response lost after message send');
      return { sent: true as const };
    },
    agentTimeline: async () => reviewerTimeline,
    agentTimelinePage: async (id: string) => toolTimelinePage(id === 'review-agent' ? reviewerTimeline as never : []),
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 3_600_000);
  engine.currentServiceBuildId = () => 'review-continuation-fixture-build';
  engine.profiles = [worker, reviewer];
  const current = () => store.task(submitted.id);
  const run = () => store.run(runId)!;
  // The raw callback receipt, before the wake it schedules: only for an oracle
  // that must observe that intermediate state (it never settles the wake).
  const reportUnsettled = (checkpoint: { covered: string[]; remaining: string[]; notes?: string }, eventId: string = randomUUID(), atHead: string = head) =>
    engine.complete({ eventId, taskId: submitted.id, runId, status: 'review_in_progress', summary: 'Reading budget exhausted', head: atHead, checkpoint }, 'token') as Promise<{ accepted: true; eventId: string; checkpoint: { ordinal: number; budget: number; continued: boolean; attention?: string } }>;
  // A callback receipt precedes its wake. Every report lets that lifecycle pass
  // record the operator-needed stop before a test reads a version for
  // authorization (task 354 settled only some callers; milestone QA a43d6304,
  // 2026-10-22, caught an unsettled one racing the stop record under load).
  // The reader reports from inside its own turn (see whileReaderInTurn).
  const report = (...args: Parameters<typeof reportUnsettled>) => whileReaderInTurn(engine, 'review-agent', () => reportUnsettled(...args));

  return { dir, store, engine, adapter, submitted, initialHead: head, initialBase: base, source, runId, current, run, report, reportUnsettled, continuations, createdRuns, reviewerDeliveries, reviewerTimeline, states,
    setVerifyBarrier: (barrier: (() => Promise<void>) | null) => { verifyBarrier = barrier; }, setDeliveryMode: (mode: typeof deliveryMode) => { deliveryMode = mode; },
    counts: () => ({ merges, syncs }), close: async () => { await engine.stop(); if(source)source.close();else{store.close(); rmSync(dir, { recursive: true, force: true });} } };
}

export type ReviewContinuationFixture = ReturnType<typeof fixture>;

export function pinReviewerRuntime(f: ReviewContinuationFixture, options: { thinkingOptionId?: string; catalogDefault?: string; supportedThinking?: string[] } = {}) {
  const thinkingOptionId = options.thinkingOptionId ?? 'high';
  const modeId = 'review-mode';
  const profile = { ...f.run().profile!, modeId, thinkingOptionId };
  f.store.putRun({ ...f.run(), profile });
  f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, reviewerProfile: profile } });
  f.engine.profiles = f.engine.profiles.map(candidate => candidate.id === profile.id ? {
    ...candidate, modeId, thinkingOptionId: options.catalogDefault ?? 'medium',
    supportedThinking: options.supportedThinking ?? ['medium', 'high', 'low'],
  } : candidate);
  f.states.set('review-agent', { ...f.states.get('review-agent')!, modeId, thinkingOptionId });
}

export function setReviewerCatalogDefault(f: ReviewContinuationFixture, thinkingOptionId: string) {
  f.engine.profiles = f.engine.profiles.map(candidate => candidate.id === f.run().profile?.id ? { ...candidate, thinkingOptionId } : candidate);
}

/** Round 4: a checkpoint continuation is `restart role=reviewer`; Queue derives the run, head and checkpoint. */
export function reviewControl(f: ReviewContinuationFixture, overrides: Partial<{ version: number; reason: string; instruction: string }> = {}) {
  return taskControlInputSchema.parse({ taskId: f.submitted.id, version: overrides.version ?? f.current().version, action: 'restart', role: 'reviewer',
    reason: overrides.reason ?? 'Operator authorizes this one bounded same-run continuation',
    instruction: overrides.instruction ?? 'Finish the remaining listed reading and report normally' });
}

export async function acceptControl(f: ReviewContinuationFixture, control: ReturnType<typeof reviewControl>, key = `review-control-${randomUUID()}`, engine = f.engine) {
  const accepted = await engine.startOperation({ key, kind: 'task_control', payload: { type: 'task_control', control }, taskId: control.taskId, expectedVersion: control.version });
  if ('backpressured' in accepted) throw new Error('review control operation was unexpectedly backpressured');
  return engine.awaitOperation(accepted.operation.id, 5_000);
}

/**
 * Real adapter observation and send-boundary checks against disposable native
 * handles. `checkout` is the retained task directory, `recordDirectory` is the
 * directory the native descriptor reports (differs only to model a moved
 * workspace), `projectRootPath: null` models an archived catalog record, and
 * `onRefresh` runs inside the nth reviewer identity refresh and `onDescriptor`
 * inside the nth workspace-descriptor read, so a test can change one fact across
 * either await.
 */
export function nativeReviewer(f: ReviewContinuationFixture, options: {
  checkout?: string; recordDirectory?: string; projectRootPath?: string | null;
  onRefresh?: (count: number) => void; onDescriptor?: (count: number) => void;
} = {}) {
  pinReviewerRuntime(f, { thinkingOptionId: 'medium' });
  const profile = { ...f.run().profile!, provider: 'claude' };
  const checkout = options.checkout ?? f.dir;
  f.store.putRun({ ...f.run(), profile });
  f.store.update(f.current().id, { directory: checkout, resolution: { ...f.current().resolution, reviewerProfile: profile } });
  f.engine.profiles = f.engine.profiles.map(item => item.id === profile.id ? { ...item, provider: 'claude' } : item);
  const runtimeInfo: { provider: string; model: string; modeId: string; thinkingOptionId?: string } = {
    provider: 'claude', model: profile.model, modeId: profile.modeId!, thinkingOptionId: 'medium',
  };
  let refreshes = 0;
  const agent = {
    runtimeInfo, workspaceId: 'workspace', status: 'idle', activeTurn: null, pendingPermissions: [], archivedAt: null,
    current: () => ({ id: 'review-agent', provider: 'claude', model: profile.model,
      thinkingOptionId: 'medium', effectiveThinkingOptionId: 'medium' }),
    refresh: async () => { refreshes += 1; options.onRefresh?.(refreshes); return true; },
    send: async (text: string, options: { messageId: string }) => {
      f.reviewerDeliveries.push({ runId: f.runId, messageId: options.messageId, text });
    },
  };
  // The descriptor is read lazily so a test can hold a reference to the same
  // options object and change the placement while the proof is in flight.
  let descriptors = 0;
  const native = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/report.mjs");
  (native as any).api = {
    agents: { ref: () => agent },
    workspaces: { ref: () => ({
      get directory() { return options.recordDirectory ?? checkout; },
      refresh: async () => true,
      current: () => {
        descriptors += 1; options.onDescriptor?.(descriptors);
        return options.projectRootPath === null ? undefined : { projectRootPath: options.projectRootPath ?? '/repo' };
      },
    }) },
  };
  const observe = f.adapter.observe;
  f.adapter.observe = id => id === 'review-agent' ? PaseoAdapter.prototype.observe.call(native, id) : observe(id);
  f.adapter.continueReviewer = (...args) => PaseoAdapter.prototype.continueReviewer.call(native, ...args);
  return agent;
}
