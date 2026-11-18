import { readFileSync } from 'node:fs';
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
  intent: string[]; settleIntent: string[]; retiredAgent: string[];
};
export const storedHostStateShape = shape;

/** One thread the stored state tracks, as its launch left it. */
export interface StoredThread {
  id: string;
  taskId: string;
  runId: string;
  /** A support role; absent for a worker-shaped launch, exactly as the wire labels are. */
  role?: string;
  workspaceId?: string;
  /** The state title the row's step rides after, when the launch recorded one. */
  title?: string;
}

/** One recorded settle the state carries, by thread. */
export interface StoredSettle { threadId: string; runId: string; commandId?: string }

export interface StoredHostStateInput {
  directory: string;
  hostId?: string;
  projectId?: string;
  threads: readonly StoredThread[];
  /** Threads whose worker settle succeeded: the durable marker an exact settle reads. */
  settled?: readonly StoredSettle[];
  /** Threads whose handover settle was recorded and never completed. */
  pendingSettles?: readonly StoredSettle[];
  /** Threads whose presentation intents are settled, so a title already landed. */
  rowTitles?: readonly { threadId: string; title: string }[];
  /** A settled deletion intent per thread, as a confirmed removal leaves it. */
  deleted?: readonly string[];
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
  const settledThreads: Record<string, string> = {};
  const pendingSettles: Record<string, unknown> = {};
  const rowTitles: Record<string, string> = {};
  const command = (purpose: string, value: unknown) => identity(purpose, canonical(value));
  for (const thread of input.threads) {
    const workspaceId = thread.workspaceId ?? `nucleus-worktree-${'0'.repeat(40)}`;
    workspaces[workspaceId] ??= { id: workspaceId, directory, projectId, title: 'Synthetic worktree', archivedAt: stamp };
    // The stored agent record carries the launch labels and the workspace, nothing else.
    agents[thread.id] = { id: thread.id, workspaceId, labels: storedT3Labels(thread.role ?? 'worker', { taskId: thread.taskId, runId: thread.runId }) };
    // Every created thread has its launch receipt in the ledger, as a real file does.
    const launch = command('thread', thread.id);
    intents[launch] = { payload: JSON.stringify({ method: 'orchestration.launchThread', payload: { threadId: thread.id } }),
      status: 'settled', result: { threadId: thread.id }, kind: 'launchThread', threadId: thread.id };
  }
  for (const settle of input.settled ?? []) {
    const commandId = settle.commandId ?? identity('settle', canonical([hostId, settle.threadId, settle.runId]));
    intents[commandId] = { payload: JSON.stringify({ method: 'orchestration.dispatchCommand',
      payload: { type: 'thread.settle', commandId, threadId: settle.threadId, expectedLatestRunId: settle.runId } }),
      status: 'settled', kind: 'thread.settle', threadId: settle.threadId };
    settledThreads[settle.threadId] = commandId;
  }
  for (const pending of input.pendingSettles ?? []) {
    const commandId = pending.commandId ?? identity('settle', canonical([hostId, pending.threadId, pending.runId]));
    // A settle that is still waiting, not one past its own TTL: the record's timestamp
    // is the handover's, and an old one is retired on age before anything reads it.
    pendingSettles[commandId] = { agentId: pending.threadId, runId: pending.runId, commandId, recordedAt: new Date().toISOString() };
  }
  for (const row of input.rowTitles ?? []) rowTitles[row.threadId] = row.title;
  for (const threadId of input.deleted ?? []) {
    // The adapter's own command identity for a removal, so a confirmed deletion is
    // read exactly as a recorded one is.
    const commandId = identity('delete', threadId);
    intents[commandId] = { payload: JSON.stringify({ method: 'orchestration.dispatchCommand',
      payload: { type: 'thread.delete', commandId, threadId } }), status: 'settled', kind: 'thread.delete', threadId };
  }
  return { version: 1 as const, hostId, lastPassedVersion: 'nightly-synthetic',
    workspaces, agents, intents, pendingSettles, settledThreads,
    workerSettles: {}, rowTitles,
    // The client's own hide switch, read once at connect and never written.
    supportThreads: 'setting_off',
    nesting: { state: 'fallback', reason: 'T3Code has no nucleus ACP provider instance', at: stamp } };
}

/** The task fact one stored thread's launch names, as a `Task`'s phase reads it. */
export const taskFact = (id: string, phase: string) => ({ id, phase, hostId: 't3code:synthetic-environment', removedAt: null });
