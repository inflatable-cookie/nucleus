import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatAgentId, parseAgentId } from '../../shared/agent-identity';
import { isOperatorOrigin, taskOwner, taskPlanner, type Project } from '../../shared/contracts';
import type { Engine } from '../engine';
import { writeOwnedJson } from '../machine/owned-file.mjs';
import { digest, type Store } from '../store/store';

export const plannerTicketKey = (project: string) => `plannerParticipant:${project}`;
/** Task 1109: one identity ticket per task-planner thread, so a planner on any host can answer. */
export const taskPlannerTicketKey = (hostId: string, nativeAgentId: string) =>
  `taskPlannerParticipant:${JSON.stringify([hostId, nativeAgentId])}`;
interface PlannerParticipant {
  participantId: string;
  /** Project tickets carry their project and assignment; task-planner tickets carry neither. */
  projectKey?: string;
  agentId: string;
  setAt?: string;
  hostId: string;
  nativeAgentId: string;
  tokenHash: string;
  path: string;
  delivery: 'intent' | 'delivered' | 'unknown';
}
/** The thread every live task's planning questions reach, with the host its identity is proven on. */
interface PlannedThread { agentId: string; nativeAgentId: string; hostId?: string }

/**
 * The thread each live task's planning questions reach (task 1109). A task planner
 * that no live task names is no longer a planner, which is what revokes its ticket;
 * reparenting moves the task, and so the scope.
 */
function plannedThreads(store: Store): PlannedThread[] {
  const planned = new Map<string, PlannedThread>();
  for (const task of store.liveTasks()) {
    const planner = taskPlanner(task);
    if (isOperatorOrigin(planner)) continue;
    const qualified = parseAgentId(planner);
    const nativeAgentId = qualified?.nativeAgentId ?? planner;
    const hostId = qualified?.hostId ?? (taskOwner(task) === planner ? task.originHostId : undefined);
    const key = JSON.stringify([hostId ?? null, nativeAgentId]);
    if (!planned.has(key)) planned.set(key, { agentId: planner, nativeAgentId, hostId });
  }
  return [...planned.values()];
}

/** Whether a ticket's thread still plans a live task, on the host its ticket was issued for. */
function stillPlansATask(store: Store, participant: Pick<PlannerParticipant, 'nativeAgentId' | 'hostId'>): boolean {
  return plannedThreads(store).some(planned => planned.nativeAgentId === participant.nativeAgentId
    && (!planned.hostId || planned.hostId === participant.hostId));
}

/** A delegate prompt may name the registered ticket path without reading its credential. */
export function plannerParticipantTicketPath(store: Store, recipient: string, hostId?: string): string | undefined {
  const native = parseAgentId(recipient)?.nativeAgentId ?? recipient;
  for (const project of store.projects()) {
    const participant = store.getMeta<PlannerParticipant>(plannerTicketKey(project.key));
    if (participant && participant.nativeAgentId === native && participant.hostId === hostId
      && project.planner?.agentId === participant.agentId && project.planner.setAt === participant.setAt)
      return participant.path;
  }
  if (!hostId) return undefined;
  const participant = store.getMeta<PlannerParticipant>(taskPlannerTicketKey(hostId, native));
  return participant?.nativeAgentId === native && stillPlansATask(store, participant) ? participant.path : undefined;
}

/** Authenticate a ticket against its current Nucleus record, never its claimed identity. */
export function resolveTicketCaller(store: Store, input: CallerTicket, token: string) {
  if ('participantId' in input) {
    const projectKey = store.getMeta<string>(`plannerParticipantId:${input.participantId}`);
    const taskPlannerKey = store.getMeta<string>(`taskPlannerParticipantId:${input.participantId}`);
    const participant = projectKey ? store.getMeta<PlannerParticipant>(plannerTicketKey(projectKey))
      : taskPlannerKey ? store.getMeta<PlannerParticipant>(taskPlannerKey) : null;
    const planner = projectKey ? store.projectByKey(projectKey)?.planner : null;
    if (!participant || participant.participantId !== input.participantId || participant.tokenHash !== digest(token)
      // A project ticket is revoked by its assignment changing; a task-planner ticket by
      // no live task naming that thread any more (reparenting moves the scope).
      || (projectKey ? !planner || planner.agentId !== participant.agentId || planner.setAt !== participant.setAt
        : !stillPlansATask(store, participant)))
      throw Error('Planner participant ticket is revoked or invalid');
    return { caller: formatAgentId(participant.hostId, participant.nativeAgentId), hostId: participant.hostId, source: 'participant-ticket' as const };
  }
  store.authenticate(input.runId, token);
  const task = store.task(input.taskId), run = store.run(input.runId);
  if (run?.released) throw Error('Calling run ticket is released');
  if (run ? run.taskId !== task.id : task.runId !== input.runId) throw Error('Stale report: task and run identity do not match');
  const agentId = run ? run.agentId : task.agentId, hostId = run ? run.hostId : task.hostId;
  if (!agentId || !hostId) throw Error('No calling thread and proven host bound to this run');
  return { caller: formatAgentId(hostId, agentId), hostId, source: 'run-ticket' as const };
}
export type CallerTicket = { taskId: string; runId: string } | { participantId: string };

/**
 * One owner-only identity ticket per planner assignment, delivered once through its
 * host. Project planners are keyed per project assignment; a task planner (task
 * 1109) is keyed per thread, because one thread may plan many tasks.
 */
export class PlannerParticipantTickets {
  private pending: Promise<void> | null = null;
  private requested = false;
  private readonly issuing = new Map<string, Promise<void>>();
  constructor(private readonly engine: Engine, private readonly paths: { socketPath: string; helperPath: string }) {}

  ensure(): Promise<void> {
    this.requested = true;
    if (this.pending) return this.pending;
    const work = (async () => {
      while (this.requested) {
        this.requested = false;
        await this.issueRecordedPlanners();
      }
    })();
    this.pending = work.finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Issue this thread's task-planner ticket before a question names it; a proven no-op afterwards. */
  ensureFor(agentId: string, hostId: string): Promise<void> {
    const qualified = parseAgentId(agentId);
    const nativeAgentId = qualified?.nativeAgentId ?? agentId;
    const ownHost = qualified?.hostId ?? hostId;
    const key = taskPlannerTicketKey(ownHost, nativeAgentId);
    if (this.engine.store.getMeta(key)) return Promise.resolve();
    const running = this.issuing.get(key);
    if (running) return running;
    const work = this.issueTaskPlanner(agentId, ownHost, nativeAgentId).finally(() => this.issuing.delete(key));
    this.issuing.set(key, work);
    return work;
  }

  private async issueRecordedPlanners(): Promise<void> {
    for (const project of this.engine.store.projects()) {
      if (!project.planner || this.engine.store.getMeta(plannerTicketKey(project.key))) continue;
      try { await this.issue(project); }
      catch (error) {
        // A proven pre-send lookup failure can be tried on the next host connect.
        // Once intent exists, even a thrown send is never replayed.
        this.engine.store.event(`project:${project.key}`, 'planner_ticket_unavailable', error instanceof Error ? error.message : String(error));
      }
    }
    for (const planned of plannedThreads(this.engine.store)) {
      try { await this.ensureFor(planned.agentId, planned.hostId ?? await this.engine.identifyOriginHost(planned.agentId) ?? ''); }
      catch (error) {
        this.engine.store.event('queue', 'task_planner_ticket_unavailable', error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** One record, written with intent before its delivery; the same write the project tickets use. */
  private ticketPaths(participantId: string) {
    const directory = join(dirname(this.paths.helperPath), 'tickets');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return { directory, path: join(directory, `participant-${participantId}.json`) };
  }

  private async deliver(participant: PlannerParticipant, text: string, key: string): Promise<void> {
    const current = () => this.engine.store.getMeta<PlannerParticipant>(key)?.participantId === participant.participantId;
    try {
      await this.engine.withHost(participant.hostId, () => this.engine.host.sendMessage(participant.nativeAgentId, {
        messageId: `nucleus-planner-ticket-${participant.participantId}`, text }));
      if (current()) this.engine.store.setMeta(key, { ...participant, delivery: 'delivered' });
    } catch (error) {
      if (current()) this.engine.store.setMeta(key, { ...participant, delivery: 'unknown' });
      throw error;
    }
  }

  private async issue(project: Project): Promise<void> {
    const planner = project.planner!;
    const generation = this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`);
    const qualified = parseAgentId(planner.agentId);
    const hostId = qualified?.hostId ?? await this.engine.identifyOriginHost(planner.agentId);
    if (!hostId || !this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))) return;
    const nativeAgentId = qualified?.nativeAgentId ?? planner.agentId;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const key = plannerTicketKey(project.key);
    const path = this.ticketPaths(participantId).path;
    const participant: PlannerParticipant = { participantId, projectKey: project.key, agentId: planner.agentId,
      setAt: planner.setAt, hostId, nativeAgentId, tokenHash: digest(token), path, delivery: 'intent' };
    const stillCurrent = () => {
      const current = this.engine.store.projectByKey(project.key)?.planner;
      return current?.agentId === planner.agentId && current.setAt === planner.setAt
        && this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`) === generation;
    };
    if (!stillCurrent() || this.engine.store.getMeta(key)) return;
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillCurrent()) throw Error('Planner changed before ticket delivery');
      this.engine.store.setMeta(key, participant);
      this.engine.store.setMeta(`plannerParticipantId:${participantId}`, project.key);
    });
    await this.deliver(participant, `Nucleus has registered you as the planner for ${project.name}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this planner assignment changes.`, key);
  }

  /**
   * Task 1109: the thread that answers one task's planning questions gets the same
   * ticket, so `question.answer` works on a host without per-thread identity. It is
   * issued only for a thread that still plans a live task; no task means no ticket.
   */
  private async issueTaskPlanner(agentId: string, hostId: string, nativeAgentId: string): Promise<void> {
    if (!hostId) return;
    const key = taskPlannerTicketKey(hostId, nativeAgentId);
    const stillPlans = () => stillPlansATask(this.engine.store, { nativeAgentId, hostId });
    if (!stillPlans() || this.engine.store.getMeta(key)) return;
    if (!this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))) return;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const path = this.ticketPaths(participantId).path;
    const participant: PlannerParticipant = { participantId, agentId, hostId, nativeAgentId,
      tokenHash: digest(token), path, delivery: 'intent' };
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillPlans()) throw Error('Task planner changed before ticket delivery');
      this.engine.store.setMeta(key, participant);
      this.engine.store.setMeta(`taskPlannerParticipantId:${participantId}`, key);
    });
    await this.deliver(participant, `Nucleus has registered you as the planner for a task it is running. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when no live task names you as its planner.`, key);
  }
}
