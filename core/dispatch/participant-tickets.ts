import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatAgentId, parseAgentId } from '../../shared/agent-identity';
import { hostKindOf } from '../../shared/host-kind';
import { isOperatorOrigin, taskOwner, taskPlanner, type Project } from '../../shared/contracts';
import type { Engine } from '../engine';
import { writeOwnedJson } from '../machine/owned-file.mjs';
import { digest, type Store } from '../store/store';

export const plannerTicketKey = (project: string) => `plannerParticipant:${project}`;
/** A planner with no usable ticket yet: the board's project entry says so. */
export const plannerTicketPendingKey = (project: string) => `plannerTicketPending:${project}`;
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
  /** How the thread received its identity: its own call, one host message, or unknown. */
  delivery: 'intent' | 'self' | 'delivered' | 'unknown';
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
export type CallerTicket = { taskId: string; runId: string } | { participantId: string };

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

/**
 * One owner-only identity ticket per planner assignment. Startup never messages a
 * planner thread: a recorded planner without a ticket is marked ticket pending,
 * and the ticket reaches the thread either in the response to its own
 * authenticated call or, only where that route does not exist and the thread is
 * observed live, through one host message. No send is ever repeated.
 *
 * Task 1109 adds a second scope: the thread that answers one task's planning
 * questions. Its ticket is keyed per thread, because one thread may plan many
 * tasks, and it travels the same two routes.
 */
export class PlannerParticipantTickets {
  private pending: Promise<void> | null = null;
  private requested = false;
  private readonly issuing = new Map<string, Promise<void>>();
  constructor(private readonly engine: Engine, private readonly paths: { socketPath: string; helperPath: string }) {}

  /** Startup and reconnect reconciliation. It records state and sends nothing. */
  ensure(): Promise<void> {
    this.requested = true;
    if (this.pending) return this.pending;
    const work = (async () => {
      while (this.requested) {
        this.requested = false;
        this.markPendingPlanners();
      }
    })();
    this.pending = work.finally(() => { this.pending = null; });
    return this.pending;
  }

  /** The board's project entry: this planner has no usable ticket yet. */
  pendingPlanners(): ReadonlySet<string> {
    return new Set(this.engine.store.projects()
      .filter(project => project.planner && this.engine.store.getMeta(plannerTicketPendingKey(project.key)))
      .map(project => project.key));
  }

  /**
   * The planner's own authenticated call. Its ticket travels in the response, so
   * nothing is sent to a thread that reached Nucleus itself.
   */
  async forCaller(caller: string): Promise<string | undefined> {
    const qualified = parseAgentId(caller);
    if (!qualified) return undefined;
    for (const project of this.engine.store.projects()) {
      const planner = project.planner;
      if (!planner || this.engine.store.getMeta(plannerTicketKey(project.key))) continue;
      // Only the identity the record names may take its ticket: a bare legacy id
      // is bound to this caller only when this caller set it.
      if (planner.agentId !== caller && !(planner.agentId === qualified.nativeAgentId && planner.setBy === caller)) continue;
      try { return (await this.issue(project, 'self'))?.path; }
      catch (error) {
        this.markPending(project, error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    // Task 1109: a thread that still plans live tasks takes its task-planner ticket here too.
    if (this.engine.store.getMeta(taskPlannerTicketKey(qualified.hostId, qualified.nativeAgentId))
      || !stillPlansATask(this.engine.store, { nativeAgentId: qualified.nativeAgentId, hostId: qualified.hostId })) return undefined;
    try { return (await this.issueTaskPlanner(caller, qualified.hostId, qualified.nativeAgentId, 'self'))?.path; }
    catch { return undefined; }
  }

  /**
   * One assignment, answered in the call that made it. A thread that named itself
   * receives the ticket in this response. A planner whose host supplies its own
   * calling-thread identity takes its ticket on its next call, so nothing is sent.
   * Every other host gets one message, and only when its thread is observed live.
   */
  async assigned(projectKey: string): Promise<string | undefined> {
    const project = this.engine.store.projectByKey(projectKey);
    this.engine.store.deleteMeta(plannerTicketPendingKey(projectKey));
    if (!project?.planner || this.engine.store.getMeta(plannerTicketKey(projectKey))) return undefined;
    const hostId = await this.originHost(project);
    if (!hostId) {
      this.markPending(project, 'no proven host for the planner thread');
      return undefined;
    }
    // A self-naming thread is the caller: its own assignment call carries the ticket.
    if (project.planner.setBy === project.planner.agentId) {
      try { return (await this.issue(project, 'self'))?.path; }
      catch (error) {
        this.markPending(project, error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    if (hostKindOf(hostId) === 'paseo') {
      this.markPending(project, 'the host hands the ticket to the planner on its own next call');
      return undefined;
    }
    let live = false;
    try {
      live = await this.observeLive(project.planner.agentId, hostId);
    } catch (error) {
      // An unreadable thread is not a live one: nothing is sent, and the board
      // keeps saying the ticket is pending.
      this.engine.store.event(`project:${project.key}`, 'planner_ticket_unavailable', error instanceof Error ? error.message : String(error));
    }
    if (!live) {
      this.markPending(project, 'the planner thread is not observed live, so no message is sent');
      return undefined;
    }
    try {
      await this.issue(project, 'message');
    } catch (error) {
      this.markPending(project, 'ticket delivery is unknown; it is never resent');
      this.engine.store.event(`project:${project.key}`, 'planner_ticket_unavailable', error instanceof Error ? error.message : String(error));
    }
    return undefined;
  }

  /**
   * Task 1109: issue a task planner's ticket before a question names it. A Paseo
   * host hands it over on the planner's own next call, so nothing is sent; another
   * host gets one message, and only while the thread is observed live. A failed
   * send is retained as unknown and never repeated.
   */
  ensureFor(agentId: string, hostId: string): Promise<void> {
    const qualified = parseAgentId(agentId);
    const nativeAgentId = qualified?.nativeAgentId ?? agentId;
    const ownHost = qualified?.hostId ?? hostId;
    const key = taskPlannerTicketKey(ownHost, nativeAgentId);
    if (!ownHost || this.engine.store.getMeta(key)
      || !stillPlansATask(this.engine.store, { nativeAgentId, hostId: ownHost })) return Promise.resolve();
    const running = this.issuing.get(key);
    if (running) return running;
    const work = this.issueTaskPlanner(agentId, ownHost, nativeAgentId, 'message')
      .then(() => undefined).finally(() => this.issuing.delete(key));
    this.issuing.set(key, work);
    return work;
  }

  private markPendingPlanners(): void {
    for (const project of this.engine.store.projects()) {
      if (!project.planner || this.engine.store.getMeta(plannerTicketKey(project.key))) continue;
      this.markPending(project, 'a recorded planner has no ticket yet; it is handed over on the planner\'s own next call');
    }
  }

  private markPending(project: Project, reason: string): void {
    const planner = project.planner;
    if (!planner) return;
    const existing = this.engine.store.getMeta<{ agentId: string; setAt: string }>(plannerTicketPendingKey(project.key));
    if (existing?.agentId === planner.agentId && existing.setAt === planner.setAt) return;
    this.engine.store.setMeta(plannerTicketPendingKey(project.key), { agentId: planner.agentId, setAt: planner.setAt, reason });
    this.engine.store.event(`project:${project.key}`, 'planner_ticket_pending', `${planner.agentId}: ${reason}`);
  }

  /** A lookup that cannot prove a host is a refusal to send, never a failed assignment. */
  private async originHost(project: Project): Promise<string | undefined> {
    const planner = project.planner!;
    const qualified = parseAgentId(planner.agentId);
    let hostId: string | undefined;
    try { hostId = qualified?.hostId ?? await this.engine.identifyOriginHost(planner.agentId); }
    catch { return undefined; }
    return hostId && this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId)) ? hostId : undefined;
  }

  /** Only a complete read that says the thread exists and is neither archived nor gone counts. */
  private async observeLive(agentId: string, hostId: string): Promise<boolean> {
    const nativeAgentId = parseAgentId(agentId)?.nativeAgentId ?? agentId;
    return this.engine.withHost(hostId, async () => {
      const origin = await this.engine.host.originAgent(nativeAgentId);
      if (!origin || origin.archived) return false;
      const observation = await this.engine.host.observe(nativeAgentId);
      return origin.id === nativeAgentId && observation.id === nativeAgentId && observation.status !== 'archived' && observation.status !== 'gone';
    });
  }

  private ticketPath(participantId: string): string {
    const directory = join(dirname(this.paths.helperPath), 'tickets');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, `participant-${participantId}.json`);
  }

  private async issue(project: Project, route: 'self' | 'message'): Promise<PlannerParticipant | undefined> {
    const planner = project.planner!;
    const generation = this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`);
    const qualified = parseAgentId(planner.agentId);
    const hostId = await this.originHost(project);
    if (!hostId) return undefined;
    const nativeAgentId = qualified?.nativeAgentId ?? planner.agentId;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const key = plannerTicketKey(project.key);
    const path = this.ticketPath(participantId);
    const participant: PlannerParticipant = { participantId, projectKey: project.key, agentId: planner.agentId,
      setAt: planner.setAt, hostId, nativeAgentId, tokenHash: digest(token), path, delivery: route === 'self' ? 'self' : 'intent' };
    const stillCurrent = () => {
      const current = this.engine.store.projectByKey(project.key)?.planner;
      return current?.agentId === planner.agentId && current.setAt === planner.setAt
        && this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`) === generation;
    };
    if (!stillCurrent() || this.engine.store.getMeta(key)) return undefined;
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillCurrent()) throw Error('Planner changed before ticket delivery');
      this.engine.store.setMeta(key, participant);
      this.engine.store.setMeta(`plannerParticipantId:${participantId}`, project.key);
      this.engine.store.deleteMeta(plannerTicketPendingKey(project.key));
    });
    if (route === 'self') return participant;
    try {
      await this.engine.withHost(hostId, () => this.engine.host.sendMessage(nativeAgentId, {
        messageId: `nucleus-planner-ticket-${participantId}`,
        text: `Nucleus has registered you as the planner for ${project.name}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this planner assignment changes.`,
      }));
      if (this.engine.store.getMeta<PlannerParticipant>(key)?.participantId === participantId)
        this.engine.store.setMeta(key, { ...participant, delivery: 'delivered' });
    } catch (error) {
      if (this.engine.store.getMeta<PlannerParticipant>(key)?.participantId === participantId)
        this.engine.store.setMeta(key, { ...participant, delivery: 'unknown' });
      throw error;
    }
    return participant;
  }

  /**
   * Task 1109: the same write and the same two routes for a thread that answers one
   * task's planning questions. Its scope is re-derived from live tasks, so nothing
   * here has to be revoked by hand when a task is reparented.
   */
  private async issueTaskPlanner(agentId: string, hostId: string, nativeAgentId: string,
    route: 'self' | 'message'): Promise<PlannerParticipant | undefined> {
    const key = taskPlannerTicketKey(hostId, nativeAgentId);
    const stillPlans = () => stillPlansATask(this.engine.store, { nativeAgentId, hostId });
    if (!stillPlans() || this.engine.store.getMeta(key)) return undefined;
    if (!this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))) return undefined;
    // A Paseo host hands the ticket over on the planner's own next call.
    if (route === 'message' && (hostKindOf(hostId) === 'paseo' || !await this.observeLive(agentId, hostId).catch(() => false))) return undefined;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const path = this.ticketPath(participantId);
    const participant: PlannerParticipant = { participantId, agentId, hostId, nativeAgentId,
      tokenHash: digest(token), path, delivery: route === 'self' ? 'self' : 'intent' };
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillPlans()) throw Error('Task planner changed before ticket delivery');
      this.engine.store.setMeta(key, participant);
      this.engine.store.setMeta(`taskPlannerParticipantId:${participantId}`, key);
    });
    if (route === 'self') return participant;
    try {
      await this.engine.withHost(hostId, () => this.engine.host.sendMessage(nativeAgentId, {
        messageId: `nucleus-planner-ticket-${participantId}`,
        text: `Nucleus has registered you as the planner for a task it is running. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when no live task names you as its planner.`,
      }));
      if (this.engine.store.getMeta<PlannerParticipant>(key)?.participantId === participantId)
        this.engine.store.setMeta(key, { ...participant, delivery: 'delivered' });
    } catch (error) {
      if (this.engine.store.getMeta<PlannerParticipant>(key)?.participantId === participantId)
        this.engine.store.setMeta(key, { ...participant, delivery: 'unknown' });
      this.engine.store.event('queue', 'task_planner_ticket_unavailable', error instanceof Error ? error.message : String(error));
    }
    return participant;
  }
}
