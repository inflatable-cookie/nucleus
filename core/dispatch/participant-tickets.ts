import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatAgentId, parseAgentId } from '../../shared/agent-identity';
import { hostKindOf } from '../../shared/host-kind';
import type { Project } from '../../shared/contracts';
import type { Engine } from '../engine';
import { writeOwnedJson } from '../machine/owned-file.mjs';
import { digest, type Store } from '../store/store';

export const plannerTicketKey = (project: string) => `plannerParticipant:${project}`;
/** A planner with no usable ticket yet: the board's project entry says so. */
export const plannerTicketPendingKey = (project: string) => `plannerTicketPending:${project}`;
interface PlannerParticipant {
  participantId: string;
  projectKey: string;
  agentId: string;
  setAt: string;
  hostId: string;
  nativeAgentId: string;
  tokenHash: string;
  path: string;
  /** How the thread received its identity: its own call, one host message, or unknown. */
  delivery: 'intent' | 'self' | 'delivered' | 'unknown';
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
  return undefined;
}

/** Authenticate a ticket against its current Nucleus record, never its claimed identity. */
export function resolveTicketCaller(store: Store, input: CallerTicket, token: string) {
  if ('participantId' in input) {
    const projectKey = store.getMeta<string>(`plannerParticipantId:${input.participantId}`);
    const participant = projectKey ? store.getMeta<PlannerParticipant>(plannerTicketKey(projectKey)) : null;
    const planner = projectKey ? store.projectByKey(projectKey)?.planner : null;
    if (!participant || participant.participantId !== input.participantId || participant.tokenHash !== digest(token)
      || !planner || planner.agentId !== participant.agentId || planner.setAt !== participant.setAt)
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
 */
export class PlannerParticipantTickets {
  private pending: Promise<void> | null = null;
  private requested = false;
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
    return undefined;
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

  private async issue(project: Project, route: 'self' | 'message'): Promise<PlannerParticipant | undefined> {
    const planner = project.planner!;
    const generation = this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`);
    const qualified = parseAgentId(planner.agentId);
    const hostId = await this.originHost(project);
    if (!hostId) return undefined;
    const nativeAgentId = qualified?.nativeAgentId ?? planner.agentId;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const directory = join(dirname(this.paths.helperPath), 'tickets');
    const path = join(directory, `participant-${participantId}.json`);
    const participant: PlannerParticipant = { participantId, projectKey: project.key, agentId: planner.agentId,
      setAt: planner.setAt, hostId, nativeAgentId, tokenHash: digest(token), path, delivery: route === 'self' ? 'self' : 'intent' };
    const stillCurrent = () => {
      const current = this.engine.store.projectByKey(project.key)?.planner;
      return current?.agentId === planner.agentId && current.setAt === planner.setAt
        && this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`) === generation;
    };
    if (!stillCurrent() || this.engine.store.getMeta(plannerTicketKey(project.key))) return undefined;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillCurrent()) throw Error('Planner changed before ticket delivery');
      this.engine.store.setMeta(plannerTicketKey(project.key), participant);
      this.engine.store.setMeta(`plannerParticipantId:${participantId}`, project.key);
      this.engine.store.deleteMeta(plannerTicketPendingKey(project.key));
    });
    if (route === 'self') return participant;
    try {
      await this.engine.withHost(hostId, () => this.engine.host.sendMessage(nativeAgentId, {
        messageId: `nucleus-planner-ticket-${participantId}`,
        text: `Nucleus has registered you as the planner for ${project.name}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this planner assignment changes.`,
      }));
      if (this.engine.store.getMeta<PlannerParticipant>(plannerTicketKey(project.key))?.participantId === participantId)
        this.engine.store.setMeta(plannerTicketKey(project.key), { ...participant, delivery: 'delivered' });
    } catch (error) {
      if (this.engine.store.getMeta<PlannerParticipant>(plannerTicketKey(project.key))?.participantId === participantId)
        this.engine.store.setMeta(plannerTicketKey(project.key), { ...participant, delivery: 'unknown' });
      throw error;
    }
    return participant;
  }
}
