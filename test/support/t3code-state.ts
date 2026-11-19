import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIRE_LABEL_KEYS } from '../../shared/wire-labels';
import { identity } from '../../hosts/t3code/intents';
import { canonical } from '../../hosts/t3code/state';
import { storedT3Labels } from './t3code-labels';

/**
 * A host state file in the shape the adapter really stores
 * (`hosts/t3code.json` under the Nucleus data home), with synthetic values.
 *
 * A test that hand-builds a partial state cannot prove anything about the
 * adapter's own bookkeeping: the fixture below is the stored top-level key set,
 * and every record is written with the same keys the stored file carries
 * (nucleus#1328). The key lists are captured read-only from the operator's file;
 * nothing in them is a value.
 */
const shape = JSON.parse(readFileSync(new URL('../fixtures/t3code-host-state.json', import.meta.url), 'utf8')) as {
  shapeOf: string; topLevel: string[]; agent: string[]; workspace: string[];
  intent: string[]; retiredAgent: string[];
};
export const storedHostStateShape = shape;

/** One thread the stored state tracks, as its launch left it. */
export interface StoredThread {
  id: string;
  taskId: string;
  runId: string;
  /** The parent thread this role thread was created as a delegated child of. */
  parentThreadId?: string;
  /** A support role; absent for a worker-shaped launch, exactly as the wire labels are. */
  role?: string;
  workspaceId?: string;
  /** The state title the row's step rides after, when the launch recorded one. */
  title?: string;
}

export interface StoredHostStateInput {
  directory: string;
  hostId?: string;
  projectId?: string;
  threads: readonly StoredThread[];
  /** Threads whose presentation intents are settled, so a title already landed. */
  rowTitles?: readonly { threadId: string; title: string }[];
  /** A settled deletion intent per thread, as a confirmed removal leaves it. */
  deleted?: readonly string[];
  /** Tasks this host runs on its own parent thread, which is what makes a child a child. */
  parents?: readonly { taskId: string; threadId: string; title?: string }[];
}

const stamp = '2026-11-16T00:00:00.000Z';

/**
 * One stored state file. A thread's worker settle is recorded as a settled ledger
 * entry under its own command id, which is exactly what the adapter writes, so an
 * exact settle still finds its receipt after the thread's live record is gone.
 */
export function storedHostState(input: StoredHostStateInput) {
  const hostId = input.hostId ?? 't3code:synthetic-environment';
  const projectId = input.projectId ?? 'synthetic-project';
  const directory = input.directory;
  const workspaces: Record<string, unknown> = {};
  const agents: Record<string, unknown> = {};
  const intents: Record<string, unknown> = {};
  const rowTitles: Record<string, string> = {};
  const command = (purpose: string, value: unknown) => identity(purpose, canonical(value));
  for (const thread of input.threads) {
    const workspaceId = thread.workspaceId ?? `nucleus-worktree-${'0'.repeat(40)}`;
    workspaces[workspaceId] ??= { id: workspaceId, directory, projectId, title: 'Synthetic worktree', archivedAt: stamp };
    // The stored agent record carries the launch labels and the workspace, nothing else.
    agents[thread.id] = { id: thread.id, workspaceId, labels: storedT3Labels(thread.role ?? 'worker', { taskId: thread.taskId, runId: thread.runId }),
      ...(thread.parentThreadId === undefined ? {} : { parentThreadId: thread.parentThreadId }),
      ...(thread.title === undefined ? {} : { title: thread.title }) };
    // Every created thread has its launch receipt in the ledger, as a real file does.
    const launch = command('thread', thread.id);
    intents[launch] = { payload: JSON.stringify({ method: 'orchestration.launchThread', payload: { threadId: thread.id } }),
      status: 'settled', result: { threadId: thread.id }, kind: 'launchThread', threadId: thread.id };
  }
  for (const row of input.rowTitles ?? []) rowTitles[row.threadId] = row.title;
  for (const threadId of input.deleted ?? []) {
    // The adapter's own command identity for a removal, so a confirmed deletion is
    // read exactly as a recorded one is.
    const commandId = identity('delete', threadId);
    intents[commandId] = { payload: JSON.stringify({ method: 'orchestration.dispatchCommand',
      payload: { type: 'thread.delete', commandId, threadId } }), status: 'settled', kind: 'thread.delete', threadId };
  }
  // A parent thread record: the row a task's children are drawn inside. Its workspace
  // is the task's own worktree handle, which is the only handle a role child inherits.
  const parents: Record<string, unknown> = {};
  const parentWorkspace = (Object.values(workspaces)[0] as { id?: string } | undefined)?.id ?? `nucleus-worktree-${'0'.repeat(40)}`;
  for (const parent of input.parents ?? []) parents[parent.taskId] = { taskId: parent.taskId, threadId: parent.threadId,
    sessionId: `synthetic-session-${parent.taskId}`, bindingPath: join(directory, '.nucleus-acp.json'),
    workspaceId: parentWorkspace, projectId, directory, createdAt: stamp,
    ...(parent.title === undefined ? {} : { title: parent.title }) };
  return { version: 1 as const, hostId, lastPassedVersion: 'nightly-synthetic',
    ...(input.parents?.length ? { parents } : {}),
    workspaces, agents, intents, rowTitles,
    nesting: { state: 'unavailable', reason: 'T3Code has no nucleus ACP provider instance', at: stamp } };
}

/** The task fact one stored thread's launch names, as a `Task`'s phase reads it. */
export const taskFact = (id: string, phase: string) => ({ id, phase, hostId: 't3code:synthetic-environment', removedAt: null });
