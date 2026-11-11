import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatAgentId, parseAgentId } from '../../shared/agent-identity';
import { hostKindOf } from '../../shared/host-kind';
import type { Project, ProjectAgent } from '../../shared/contracts';
import type { Engine } from '../engine';
import { writeOwnedJson } from '../machine/owned-file.mjs';
import { digest, type Store } from '../store/store';

export const plannerTicketKey = (project: string) => `plannerParticipant:${project}`;
/** A planner with no usable ticket yet: the board's project entry says so. */
export const plannerTicketPendingKey = (project: string) => `plannerTicketPending:${project}`;
/** One participant ticket per registered named agent (Spec 060). */
export const agentTicketKey = (project: string, name: string) => `projectAgentParticipant:${project}:${name}`;
/** A registered agent with no usable ticket yet. */
export const agentTicketPendingKey = (project: string, name: string) => `projectAgentTicketPending:${project}:${name}`;
const agentTicketIdKey = (participantId: string) => `projectAgentParticipantId:${participantId}`;
const AGENT_TICKET_PREFIX = 'projectAgentParticipant:';
const AGENT_PENDING_PREFIX = 'projectAgentTicketPending:';
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
interface AgentParticipant {
  participantId: string;
  projectKey: string;
  name: string;
  agentId: string;
  hostId: string;
  nativeAgentId: string;
  tokenHash: string;
  path: string;
  delivery: 'intent' | 'self' | 'delivered' | 'unknown';
}
export type CallerTicket = { taskId: string; runId: string } | { participantId: string };

/** A delegate prompt may name a registered ticket path without reading its credential. */
export function plannerParticipantTicketPath(store: Store, recipient: string, hostId?: string): string | undefined {
  const qualified = parseAgentId(recipient);
  const native = qualified?.nativeAgentId ?? recipient;
  const matchesHost = (recordHostId: string) => hostId ? recordHostId === hostId : !qualified || qualified.hostId === recordHostId;
  for (const project of store.projects()) {
    for (const agent of project.agents ?? []) {
      const record = store.getMeta<AgentParticipant>(agentTicketKey(project.key, agent.name));
      if (record && record.agentId === agent.agentId && record.nativeAgentId === native && matchesHost(record.hostId)) return record.path;
    }
    const participant = store.getMeta<PlannerParticipant>(plannerTicketKey(project.key));
    if (participant && participant.nativeAgentId === native && matchesHost(participant.hostId)
      && project.planner?.agentId === participant.agentId && project.planner.setAt === participant.setAt)
      return participant.path;
  }
  return undefined;
}

/** Authenticate a ticket against its current Nucleus record, never its claimed identity. */
export function resolveTicketCaller(store: Store, input: CallerTicket, token: string) {
  if ('participantId' in input) {
    const scoped = store.getMeta<{ projectKey: string; name: string }>(agentTicketIdKey(input.participantId));
    if (scoped) {
      const project = store.projectByKey(scoped.projectKey);
      const agent = (project?.agents ?? []).find(candidate => candidate.name === scoped.name);
      const record = store.getMeta<AgentParticipant>(agentTicketKey(scoped.projectKey, scoped.name));
      if (!agent || !record || record.participantId !== input.participantId
        || record.agentId !== agent.agentId || record.hostId !== agent.hostId || record.tokenHash !== digest(token))
        throw Error('Participant ticket is revoked or invalid');
      return { caller: formatAgentId(record.hostId, record.nativeAgentId), hostId: record.hostId, source: 'participant-ticket' as const };
    }
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
 * One participant ticket per registered thread: a project's planner assignment
 * (Spec 058) and every named agent (Spec 060). A ticket reaches its thread
 * through the thread's own authenticated call in the normal case; only a host
 * with no such route gets one message, and only to a thread observed live. No
 * send is ever repeated, and startup never messages a thread.
 */
export class ParticipantTickets {
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
        await this.reconcile();
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
   * The thread's own authenticated call. A planner, and a registered named agent
   * that has no ticket yet, receives it in the response, so nothing is sent to a
   * thread that reached Nucleus itself.
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
    for (const project of this.engine.store.projects()) {
      for (const agent of project.agents ?? []) {
        if (this.plannerIdentityCovers(project, agent)) continue;
        if (this.engine.store.getMeta(agentTicketKey(project.key, agent.name))) continue;
        if (!this.callerIsAgent(agent, caller, qualified)) continue;
        try { return (await this.issueAgent(project, agent, 'self'))?.path; }
        catch (error) {
          this.markPendingAgent(project, agent, error instanceof Error ? error.message : String(error));
          return undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * One planner assignment, answered in the call that made it. A thread that
   * named itself receives the ticket in this response. A planner whose host
   * supplies its own calling-thread identity takes its ticket on its next call,
   * so nothing is sent. Every other host gets one message, and only when its
   * thread is observed live.
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
   * One named-agent registration, answered where the registration came from.
   * `caller` names the thread that registered itself: its ticket travels in this
   * response. A board registration hands over by the same rules as a planner
   * assignment: its own next call where the host supplies identity, one message
   * to a live thread only where that route does not exist. An unregistered name
   * revokes the old ticket instead.
   */
  async agentChanged(projectKey: string, name: string, caller: string | null): Promise<string | undefined> {
    const project = this.engine.store.projectByKey(projectKey);
    if (!project) return undefined;
    // A rename, reassignment or unregistration revokes the superseded record first.
    this.pruneAgents(project);
    const agent = (project.agents ?? []).find(candidate => candidate.name === name);
    if (!agent) {
      this.revokeAgent(projectKey, name);
      return undefined;
    }
    const record = this.engine.store.getMeta<AgentParticipant>(agentTicketKey(projectKey, name));
    const current = record && record.agentId === agent.agentId && record.hostId === agent.hostId;
    if (this.plannerIdentityCovers(project, agent)) {
      // The planner's own identity ticket is this thread's ticket.
      if (!current) this.revokeAgent(projectKey, name);
      return undefined;
    }
    if (current) return undefined;
    if (!this.engine.withHost(agent.hostId, () => this.engine.hostAvailable(agent.hostId))) {
      this.markPendingAgent(project, agent, 'no proven host for the agent thread');
      return undefined;
    }
    const qualified = caller ? parseAgentId(caller) : null;
    if (caller && qualified && this.callerIsAgent(agent, caller, qualified)) {
      try { return (await this.issueAgent(project, agent, 'self'))?.path; }
      catch (error) {
        this.markPendingAgent(project, agent, error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    if (hostKindOf(agent.hostId) === 'paseo') {
      this.markPendingAgent(project, agent, 'the host hands the ticket to the agent on its own next call');
      return undefined;
    }
    let live = false;
    try { live = await this.observeLive(agent.agentId, agent.hostId); }
    catch (error) {
      this.engine.store.event(`project:${project.key}`, 'agent_ticket_unavailable', error instanceof Error ? error.message : String(error));
    }
    if (!live) {
      this.markPendingAgent(project, agent, 'the agent thread is not observed live, so no message is sent');
      return undefined;
    }
    try {
      await this.issueAgent(project, agent, 'message');
    } catch (error) {
      this.markPendingAgent(project, agent, 'ticket delivery is unknown; it is never resent');
      this.engine.store.event(`project:${project.key}`, 'agent_ticket_unavailable', error instanceof Error ? error.message : String(error));
    }
    return undefined;
  }

  private async reconcile(): Promise<void> {
    for (const project of this.engine.store.projects()) {
      try {
        const unregistered = project.planner?.agentId && !(project.agents ?? []).some(agent => agent.agentId === project.planner!.agentId)
          ? project.planner.agentId : null;
        const hostId = unregistered
          ? parseAgentId(unregistered)?.hostId ?? await this.engine.identifyOriginHost(unregistered) ?? (this.engine.adapter as { hostId?: string }).hostId ?? null
          : (this.engine.adapter as { hostId?: string }).hostId ?? null;
        if (unregistered) this.engine.store.ensureProjectFallbackAgent({ key: project.key, hostId });
      } catch (error) {
        this.engine.store.event(`project:${project.key}`, 'project_agent_register_unavailable', error instanceof Error ? error.message : String(error));
      }
      const current = this.engine.store.projectByKey(project.key);
      if (!current) continue;
      this.pruneAgents(current);
      for (const agent of current.agents ?? []) {
        if (this.plannerIdentityCovers(current, agent)) continue;
        if (this.engine.store.getMeta(agentTicketKey(current.key, agent.name))) continue;
        this.markPendingAgent(current, agent, 'a registered agent has no ticket yet; it is handed over on its own next call');
      }
    }
    this.markPendingPlanners();
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

  private markPendingAgent(project: Project, agent: ProjectAgent, reason: string): void {
    const key = agentTicketPendingKey(project.key, agent.name);
    const existing = this.engine.store.getMeta<{ agentId: string; reason: string }>(key);
    if (existing?.agentId === agent.agentId && existing.reason === reason) return;
    this.engine.store.setMeta(key, { agentId: agent.agentId, reason });
    this.engine.store.event(`project:${project.key}`, 'agent_ticket_pending', `${agent.name} (${agent.agentId}): ${reason}`);
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

  /** The fallback planner is identified by its planner ticket; a registered name adds no second one. */
  private plannerIdentityCovers(project: Project, agent: ProjectAgent): boolean {
    return Boolean(project.planner?.agentId && project.planner.agentId === agent.agentId);
  }

  /** A recorded entry answers only the identity it names: the exact caller, or its own bare native id on its own host. */
  private callerIsAgent(agent: ProjectAgent, caller: string, qualified: { hostId: string; nativeAgentId: string }): boolean {
    if (agent.agentId === caller) return true;
    if (parseAgentId(agent.agentId)) return false;
    if (agent.agentId !== qualified.nativeAgentId) return false;
    return agent.hostId === qualified.hostId
      || (hostKindOf(agent.hostId) === 'paseo' && hostKindOf(qualified.hostId) === 'paseo');
  }

  /** Remove one name's record, pending marker and participant id, so its ticket stops resolving. */
  private revokeAgent(projectKey: string, name: string): void {
    const record = this.engine.store.getMeta<AgentParticipant>(agentTicketKey(projectKey, name));
    this.engine.store.transaction(() => {
      this.engine.store.deleteMeta(agentTicketKey(projectKey, name));
      this.engine.store.deleteMeta(agentTicketPendingKey(projectKey, name));
      if (record?.participantId) this.engine.store.deleteMeta(agentTicketIdKey(record.participantId));
    });
  }

  /**
   * A record for a name the project no longer registers, or for the previous
   * thread of a renamed or reassigned name, is revoked: its participant id stops
   * resolving and its on-disk credential no longer authenticates anything.
   */
  private pruneAgents(project: Project): void {
    const names = new Map((project.agents ?? []).map(agent => [agent.name, agent]));
    const rows = this.engine.store.db.prepare(`SELECT key, value FROM meta WHERE key GLOB '${AGENT_TICKET_PREFIX}*' OR key GLOB '${AGENT_PENDING_PREFIX}*'`)
      .all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const pending = row.key.startsWith(AGENT_PENDING_PREFIX);
      const parsed = splitProjectAgentMetaKey(row.key, pending ? AGENT_PENDING_PREFIX : AGENT_TICKET_PREFIX);
      if (!parsed || parsed.projectKey !== project.key) continue;
      const agent = names.get(parsed.name);
      let record: AgentParticipant | null = null;
      try { record = JSON.parse(row.value) as AgentParticipant; } catch { record = null; }
      if (agent && record && record.agentId === agent.agentId) continue;
      this.engine.store.transaction(() => {
        this.engine.store.deleteMeta(row.key);
        if (!pending && record?.participantId) this.engine.store.deleteMeta(agentTicketIdKey(record.participantId));
      });
    }
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

  private async issueAgent(project: Project, agent: ProjectAgent, route: 'self' | 'message'): Promise<AgentParticipant | undefined> {
    const key = agentTicketKey(project.key, agent.name);
    const existing = this.engine.store.getMeta<AgentParticipant>(key);
    if (existing && existing.agentId === agent.agentId && existing.hostId === agent.hostId) return existing;
    if (!this.engine.withHost(agent.hostId, () => this.engine.hostAvailable(agent.hostId))) return undefined;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const directory = join(dirname(this.paths.helperPath), 'tickets');
    const path = join(directory, `participant-${participantId}.json`);
    const record: AgentParticipant = {
      participantId, projectKey: project.key, name: agent.name, agentId: agent.agentId, hostId: agent.hostId,
      nativeAgentId: parseAgentId(agent.agentId)?.nativeAgentId ?? agent.agentId,
      tokenHash: digest(token), path, delivery: route === 'self' ? 'self' : 'intent',
    };
    const stillCurrent = () => {
      const entry = (this.engine.store.projectByKey(project.key)?.agents ?? []).find(candidate => candidate.name === agent.name);
      return entry?.agentId === agent.agentId && entry.hostId === agent.hostId && entry.registeredAt === agent.registeredAt;
    };
    if (!stillCurrent()) return undefined;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillCurrent()) throw Error('Agent registration changed before ticket delivery');
      const current = this.engine.store.getMeta<AgentParticipant>(key);
      // A concurrent call may have issued it first: keep that one and send nothing.
      if (current && current.agentId === agent.agentId && current.hostId === agent.hostId) return;
      this.engine.store.setMeta(key, record);
      this.engine.store.setMeta(agentTicketIdKey(participantId), { projectKey: project.key, name: agent.name });
      if (existing?.participantId && existing.participantId !== participantId)
        this.engine.store.deleteMeta(agentTicketIdKey(existing.participantId));
      this.engine.store.deleteMeta(agentTicketPendingKey(project.key, agent.name));
    });
    const stored = this.engine.store.getMeta<AgentParticipant>(key);
    if (route === 'self' || stored?.participantId !== participantId) return stored;
    try {
      await this.engine.withHost(agent.hostId, () => this.engine.host.sendMessage(record.nativeAgentId, {
        messageId: `nucleus-agent-ticket-${participantId}`,
        text: `Nucleus has registered you as "${agent.name}" for ${project.name}: ${agent.purpose}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this registration is renamed, reassigned or unregistered.`,
      }));
      if (this.engine.store.getMeta<AgentParticipant>(key)?.participantId === participantId)
        this.engine.store.setMeta(key, { ...record, delivery: 'delivered' });
    } catch (error) {
      if (this.engine.store.getMeta<AgentParticipant>(key)?.participantId === participantId)
        this.engine.store.setMeta(key, { ...record, delivery: 'unknown' });
      throw error;
    }
    return record;
  }
}

function splitProjectAgentMetaKey(key: string, prefix: string): { projectKey: string; name: string } | null {
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  return { projectKey: rest.slice(0, separator), name: rest.slice(separator + 1) };
}
