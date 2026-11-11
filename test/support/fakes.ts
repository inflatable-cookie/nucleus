import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { submissionSchema, type Profile } from '../../shared/contracts';
import type { Adapter } from '../../core/host';
import type { ResolutionAdapter } from '../../core/resolution';
import { Store } from '../../core/store/store';

export function profile(id: string, model = id, overrides: Partial<Profile> = {}): Profile {
  return { id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [], ...overrides };
}

/** Only required adapter methods have defaults; optional capabilities stay absent. */
export function fakeAdapter<T>(overrides: Partial<Adapter & ResolutionAdapter> & T): Adapter & T {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected adapter call'); };
  return {
    validate: unexpected, verifyWorkspace: unexpected, createWorkspace: unexpected,
    createAgent: unexpected, observe: unexpected, verifyPr: unexpected,
    findWorkspaces: async () => [], findAgents: async () => [], archiveAgent: async () => {},
    ...overrides,
  } as Adapter & T;
}

export function submission(overrides: Record<string, unknown> = {}) {
  return submissionSchema.parse({
    submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: 'b'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin', ...overrides,
  });
}

/** Each store has its own root, and closes before its files are removed. */
export function tempStore(t: Pick<TestContext, 'after'>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nucleus-store-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

/** A plain idle observation; stateful observations stay in their fixture. */
export function observeIdle(workspaceId: string | null, fixedId?: string): Adapter['observe'] {
  return async id => ({ id: fixedId ?? id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
}

/** The ordinary task-named agent response, without callback or state side effects. */
export const createTaskAgent: Adapter['createAgent'] = async task => ({ id: `agent-${task.id}`, workspaceId: task.workspaceId });
