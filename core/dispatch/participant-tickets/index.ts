/**
 * Participant identity tickets. One owner-only ticket per planner assignment,
 * per task-planner thread and per registered named agent. Startup never messages
 * a thread: a recorded identity without a ticket is marked ticket pending, and
 * the ticket reaches the thread either in the response to its own authenticated
 * call or, only where that route does not exist and the thread is observed live,
 * through one host message. No send is ever repeated.
 *
 * Task 1109 adds the task-planner scope: the thread that answers one task's
 * planning questions. Its ticket is keyed per thread, because one thread may plan
 * many tasks, and its scope is re-derived from live tasks, so reparenting moves
 * it without a hand-written revocation.
 *
 * Spec 060 adds the project's named agents. A named agent's ticket is keyed by
 * project and name, and renaming, reassigning or unregistering the name revokes
 * it. The ticket reaches the thread by the same routes as every other one.
 */
import { existsSync } from "node:fs";
import { formatAgentId, parseAgentId } from "../../../shared/agent-identity";
import { hostKindOf } from "../../../shared/host-kind";
import type { Project, ProjectAgent } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import { digest, type Store } from "../../store/store";
import { issueTicket } from "./issue";
import { plannedThreadCovers } from "./planned-threads";
import {
  agentScopeRow, agentTicketKey, agentTicketPendingKey, agentTicketRows, dropParticipantScope, hasTicket,
  participantScopeOf, plannerGenerationKey, plannerScopeRow, plannerTicketKey, plannerTicketPendingKey,
  readTicket, taskPlannerScopeRow, taskPlannerTicketKey, ticketRows,
  type ParticipantScope, type TicketRecord,
} from "./records";

export {
  agentTicketKey, agentTicketPendingKey, plannerTicketKey, plannerTicketPendingKey, taskPlannerTicketKey,
  participantScopeOf, type ParticipantScope, type TicketRecord,
};

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export type CallerTicket = { taskId: string; runId: string } | { participantId: string };

/** A delegate prompt may name the registered ticket path without reading its credential. */
export function plannerParticipantTicketPath(store: Store, recipient: string, hostId?: string): string | undefined {
  const qualified = parseAgentId(recipient);
  const native = qualified?.nativeAgentId ?? recipient;
  const matchesHost = (recordHostId: string) => hostId ? recordHostId === hostId : !qualified || qualified.hostId === recordHostId;
  for (const project of store.projects()) {
    for (const agent of project.agents ?? []) {
      const record = readTicket(store, agentTicketKey(project.key, agent.name));
      if (record && record.agentId === agent.agentId && record.nativeAgentId === native && matchesHost(record.hostId)) return record.path;
    }
    const participant = readTicket(store, plannerTicketKey(project.key));
    if (participant && participant.nativeAgentId === native && matchesHost(participant.hostId)
      && project.planner?.agentId === participant.agentId && project.planner.setAt === participant.setAt)
      return participant.path;
  }
  if (!hostId) return undefined;
  const participant = readTicket(store, taskPlannerTicketKey(hostId, native));
  return participant?.nativeAgentId === native && plannedThreadCovers(store, { nativeAgentId: native, hostId }) ? participant.path : undefined;
}

/**
 * The project a project-scoped participant ticket speaks for: the project planner
 * (`name` null) or one named agent. A task-planner ticket names no project and reads as null.
 * Read after `resolveTicketCaller` has authenticated the ticket.
 */
export function participantProjectScope(store: Store, participantId: string): { projectKey: string; name: string | null } | null {
  const scope = participantScopeOf(store, participantId);
  if (scope?.kind === "agent") return { projectKey: scope.projectKey, name: scope.name };
  return scope?.kind === "planner" ? { projectKey: scope.projectKey, name: null } : null;
}

/** Authenticate a ticket against its current Nucleus record, never its claimed identity. */
export function resolveTicketCaller(store: Store, input: CallerTicket, token: string) {
  if ("participantId" in input) {
    const scope = participantScopeOf(store, input.participantId);
    const record = scope ? readTicket(store, scope.key) : null;
    if (!scope || !record || record.participantId !== input.participantId || record.tokenHash !== digest(token))
      throw Error(scope?.kind === "agent" ? "Participant ticket is revoked or invalid" : "Planner participant ticket is revoked or invalid");
    if (scope.kind === "agent") {
      const project = store.projectByKey(scope.projectKey);
      const agent = (project?.agents ?? []).find(candidate => candidate.name === scope.name);
      if (!agent || record.agentId !== agent.agentId || record.hostId !== agent.hostId)
        throw Error("Participant ticket is revoked or invalid");
    } else if (scope.kind === "planner") {
      // A project ticket is revoked by its assignment changing; a task-planner one
      // by no live task naming that thread any more (reparenting moves the scope).
      const planner = store.projectByKey(scope.projectKey)?.planner;
      if (!planner || planner.agentId !== record.agentId || planner.setAt !== record.setAt)
        throw Error("Planner participant ticket is revoked or invalid");
    } else if (!plannedThreadCovers(store, { nativeAgentId: record.nativeAgentId, hostId: record.hostId }))
      throw Error("Planner participant ticket is revoked or invalid");
    return { caller: formatAgentId(record.hostId, record.nativeAgentId), hostId: record.hostId, source: "participant-ticket" as const };
  }
  store.authenticate(input.runId, token);
  const task = store.task(input.taskId), run = store.run(input.runId);
  if (run?.released) throw Error("Calling run ticket is released");
  if (run ? run.taskId !== task.id : task.runId !== input.runId) throw Error("Stale report: task and run identity do not match");
  const agentId = run ? run.agentId : task.agentId, hostId = run ? run.hostId : task.hostId;
  if (!agentId || !hostId) throw Error("No calling thread and proven host bound to this run");
  return { caller: formatAgentId(hostId, agentId), hostId, source: "run-ticket" as const };
}

export class ParticipantTickets {
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
   * The planner's own authenticated call. Its ticket travels in the response, so
   * nothing is sent to a thread that reached Nucleus itself.
   */
  async forCaller(caller: string): Promise<string | undefined> {
    const qualified = parseAgentId(caller);
    if (!qualified) return undefined;
    // A caller that already holds its participant ticket keeps exactly that
    // ticket: the same path comes back on every call, and nothing is minted.
    // A ticket whose file is gone is reissued here under the existing rules —
    // the thread proved itself, so its credential must work again.
    const existing = this.existingTicket(caller, qualified.hostId);
    if (existing) return existing;
    for (const project of this.engine.store.projects()) {
      const planner = project.planner;
      if (!planner || hasTicket(this.engine.store, plannerTicketKey(project.key))) continue;
      // A bare planner is a pre-qualified Paseo identity. Its setter may be an
      // older thread or operator, so bind by native ID only on Paseo; other
      // host kinds must use an explicitly qualified planner identity.
      if (planner.agentId !== caller && !(planner.agentId === qualified.nativeAgentId && hostKindOf(qualified.hostId) === 'paseo')) continue;
      try { return (await this.issuePlanner(project, 'self'))?.path; }
      catch (error) { this.markPending(project, reasonOf(error)); return undefined; }
    }
    for (const project of this.engine.store.projects()) {
      for (const agent of project.agents ?? []) {
        if (this.plannerIdentityCovers(project, agent)) continue;
        if (hasTicket(this.engine.store, agentTicketKey(project.key, agent.name))) continue;
        if (!this.callerIsAgent(agent, caller, qualified)) continue;
        try { return (await this.issueAgent(project, agent, 'self'))?.path; }
        catch (error) { this.markPendingAgent(project, agent, reasonOf(error)); return undefined; }
      }
    }
    // Task 1109: a thread that still plans live tasks takes its task-planner ticket here too.
    if (hasTicket(this.engine.store, taskPlannerTicketKey(qualified.hostId, qualified.nativeAgentId))
      || !plannedThreadCovers(this.engine.store, { nativeAgentId: qualified.nativeAgentId, hostId: qualified.hostId })) return undefined;
    try { return (await this.issueTaskPlanner(caller, qualified.hostId, qualified.nativeAgentId, 'self'))?.path; }
    catch (error) {
      // A thread that proved itself and got no ticket is told why, instead of an
      // absence it cannot tell from "this thread plans nothing".
      this.engine.store.event('queue', 'task_planner_ticket_unavailable', reasonOf(error));
      return undefined;
    }
  }

  /**
   * The ticket a caller already holds, when it still resolves: the same record
   * the answer would authenticate. A record whose credential file is gone is
   * revoked here so the caller's own next look reissues under the existing
   * rules; a changed planner assignment or scope was already revoked by its own
   * write and falls through to a fresh issuance.
   */
  private existingTicket(caller: string, hostId: string): string | undefined {
    const path = plannerParticipantTicketPath(this.engine.store, caller, hostId);
    if (!path) return undefined;
    if (existsSync(path)) return path;
    this.revokeLostTicket(path);
    return undefined;
  }

  /** Drop every ticket record pointing at a credential file that is gone. */
  private revokeLostTicket(path: string): void {
    const store = this.engine.store;
    for (const { key, record } of ticketRows(store)) {
      if (record.path !== path) continue;
      store.transaction(() => {
        store.deleteMeta(key);
        dropParticipantScope(store, record.participantId);
      });
      store.event('queue', 'participant_ticket_reissued', `${key}: its credential file was lost; the caller's own next call reissues it`);
    }
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
    if (!project?.planner || hasTicket(this.engine.store, plannerTicketKey(projectKey))) return undefined;
    const hostId = await this.originHost(project);
    if (!hostId) {
      this.markPending(project, 'no proven host for the planner thread');
      return undefined;
    }
    // A self-naming thread is the caller: its own assignment call carries the ticket.
    if (project.planner.setBy === project.planner.agentId) {
      try { return (await this.issuePlanner(project, 'self'))?.path; }
      catch (error) {
        this.markPending(project, reasonOf(error));
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
      this.engine.store.event(`project:${project.key}`, 'planner_ticket_unavailable', reasonOf(error));
    }
    if (!live) {
      this.markPending(project, 'the planner thread is not observed live, so no message is sent');
      return undefined;
    }
    try {
      await this.issuePlanner(project, 'message');
    } catch (error) {
      this.markPending(project, 'ticket delivery is unknown; it is never resent');
      this.engine.store.event(`project:${project.key}`, 'planner_ticket_unavailable', reasonOf(error));
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
    if (!ownHost || hasTicket(this.engine.store, key)
      || !plannedThreadCovers(this.engine.store, { nativeAgentId, hostId: ownHost })) return Promise.resolve();
    const running = this.issuing.get(key);
    if (running) return running;
    const work = this.issueTaskPlanner(agentId, ownHost, nativeAgentId, 'message')
      .then(() => undefined).finally(() => this.issuing.delete(key));
    this.issuing.set(key, work);
    return work;
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
    const record = readTicket(this.engine.store, agentTicketKey(projectKey, name));
    const current = Boolean(record && record.agentId === agent.agentId && record.hostId === agent.hostId);
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
        this.markPendingAgent(project, agent, reasonOf(error));
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
      this.engine.store.event(`project:${project.key}`, 'agent_ticket_unavailable', reasonOf(error));
    }
    if (!live) {
      this.markPendingAgent(project, agent, 'the agent thread is not observed live, so no message is sent');
      return undefined;
    }
    try {
      await this.issueAgent(project, agent, 'message');
    } catch (error) {
      this.markPendingAgent(project, agent, 'ticket delivery is unknown; it is never resent');
      this.engine.store.event(`project:${project.key}`, 'agent_ticket_unavailable', reasonOf(error));
    }
    return undefined;
  }

  private async reconcile(): Promise<void> {
    for (const project of this.engine.store.projects()) {
      try {
        const unregistered = project.planner?.agentId && !(project.agents ?? []).some(agent => agent.agentId === project.planner!.agentId)
          ? project.planner.agentId : null;
        // A fallback agent is registered on the planner's own host and nowhere
        // else: the service's host is not evidence of where the thread lives, and
        // a project whose planner host cannot be proven registers none.
        if (unregistered) {
          const hostId = parseAgentId(unregistered)?.hostId ?? await this.engine.identifyOriginHost(unregistered) ?? null;
          this.engine.store.ensureProjectFallbackAgent({ key: project.key, hostId });
        }
      } catch (error) {
        this.engine.store.event(`project:${project.key}`, 'project_agent_register_unavailable', reasonOf(error));
      }
      const current = this.engine.store.projectByKey(project.key);
      if (!current) continue;
      this.pruneAgents(current);
      for (const agent of current.agents ?? []) {
        if (this.plannerIdentityCovers(current, agent)) continue;
        if (hasTicket(this.engine.store, agentTicketKey(current.key, agent.name))) continue;
        this.markPendingAgent(current, agent, 'a registered agent has no ticket yet; it is handed over on its own next call');
      }
    }
    this.markPendingPlanners();
  }

  private markPendingAgent(project: Project, agent: ProjectAgent, reason: string): void {
    const key = agentTicketPendingKey(project.key, agent.name);
    const existing = this.engine.store.getMeta<{ agentId: string; reason: string }>(key);
    if (existing?.agentId === agent.agentId && existing.reason === reason) return;
    this.engine.store.setMeta(key, { agentId: agent.agentId, reason });
    this.engine.store.event(`project:${project.key}`, 'agent_ticket_pending', `${agent.name} (${agent.agentId}): ${reason}`);
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
    const record = readTicket(this.engine.store, agentTicketKey(projectKey, name));
    this.engine.store.transaction(() => {
      this.engine.store.deleteMeta(agentTicketKey(projectKey, name));
      this.engine.store.deleteMeta(agentTicketPendingKey(projectKey, name));
      if (record?.participantId) dropParticipantScope(this.engine.store, record.participantId);
    });
  }

  /**
   * A record for a name the project no longer registers, or for the previous
   * thread of a renamed or reassigned name, is revoked: its participant id stops
   * resolving and its on-disk credential no longer authenticates anything.
   */
  private pruneAgents(project: Project): void {
    const names = new Map((project.agents ?? []).map(agent => [agent.name, agent]));
    for (const row of agentTicketRows(this.engine.store)) {
      if (row.projectKey !== project.key) continue;
      const agent = names.get(row.name);
      if (agent && row.agentId === agent.agentId) continue;
      this.engine.store.transaction(() => {
        this.engine.store.deleteMeta(row.key);
        if (!row.pending && row.participantId) dropParticipantScope(this.engine.store, row.participantId);
      });
    }
  }

  /** One named agent's registration, revoked by a rename, reassignment or unregistration. */
  private issueAgent(project: Project, agent: ProjectAgent, route: 'self' | 'message'): Promise<TicketRecord | undefined> {
    const store = this.engine.store;
    const stillCurrent = () => {
      const entry = (store.projectByKey(project.key)?.agents ?? []).find(candidate => candidate.name === agent.name);
      return entry?.agentId === agent.agentId && entry.hostId === agent.hostId && entry.registeredAt === agent.registeredAt;
    };
    return issueTicket(this.engine, this.paths, {
      key: agentTicketKey(project.key, agent.name),
      pending: [agentTicketPendingKey(project.key, agent.name)],
      index: participantId => agentScopeRow(participantId, project.key, agent.name),
      identity: { projectKey: project.key, name: agent.name, agentId: agent.agentId, hostId: agent.hostId,
        nativeAgentId: parseAgentId(agent.agentId)?.nativeAgentId ?? agent.agentId },
      current: stillCurrent,
      changed: 'Agent registration changed before ticket delivery',
      message: (participantId, path) => ({ messageId: `nucleus-agent-ticket-${participantId}`,
        text: `Nucleus has registered you as "${agent.name}" for ${project.name}: ${agent.purpose}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this registration is renamed, reassigned or unregistered.` }),
      onFailure: 'throw',
    }, route);
  }

  private markPendingPlanners(): void {
    for (const project of this.engine.store.projects()) {
      if (!project.planner || hasTicket(this.engine.store, plannerTicketKey(project.key))) continue;
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

  /** One project planner assignment, revoked when the assignment changes under it. */
  private async issuePlanner(project: Project, route: 'self' | 'message'): Promise<TicketRecord | undefined> {
    const planner = project.planner!;
    const hostId = await this.originHost(project);
    if (!hostId) return undefined;
    const store = this.engine.store;
    const generation = store.getMeta<string>(plannerGenerationKey(project.key));
    const stillCurrent = () => {
      const current = store.projectByKey(project.key)?.planner;
      return current?.agentId === planner.agentId && current.setAt === planner.setAt
        && store.getMeta<string>(plannerGenerationKey(project.key)) === generation;
    };
    return issueTicket(this.engine, this.paths, {
      key: plannerTicketKey(project.key),
      pending: [plannerTicketPendingKey(project.key)],
      index: participantId => plannerScopeRow(participantId, project.key),
      identity: { projectKey: project.key, agentId: planner.agentId, setAt: planner.setAt, hostId,
        nativeAgentId: parseAgentId(planner.agentId)?.nativeAgentId ?? planner.agentId },
      current: stillCurrent,
      changed: 'Planner changed before ticket delivery',
      message: (participantId, path) => ({ messageId: `nucleus-planner-ticket-${participantId}`,
        text: `Nucleus has registered you as the planner for ${project.name}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this planner assignment changes.` }),
      onFailure: 'throw',
    }, route);
  }

  /**
   * Task 1109: the same write and the same two routes for a thread that answers
   * one task's planning questions. Its scope is re-derived from live tasks, so
   * nothing here has to be revoked by hand when a task is reparented.
   */
  private async issueTaskPlanner(agentId: string, hostId: string, nativeAgentId: string,
    route: 'self' | 'message'): Promise<TicketRecord | undefined> {
    // A Paseo host hands the ticket over on the planner's own next call, and an
    // unobserved thread receives nothing.
    if (route === 'message' && (hostKindOf(hostId) === 'paseo' || !await this.observeLive(agentId, hostId).catch(() => false))) return undefined;
    const store = this.engine.store;
    const stillPlans = () => plannedThreadCovers(store, { nativeAgentId, hostId });
    return issueTicket(this.engine, this.paths, {
      key: taskPlannerTicketKey(hostId, nativeAgentId),
      pending: [],
      index: participantId => taskPlannerScopeRow(participantId, taskPlannerTicketKey(hostId, nativeAgentId)),
      identity: { agentId, hostId, nativeAgentId },
      current: stillPlans,
      changed: 'Task planner changed before ticket delivery',
      message: (participantId, path) => ({ messageId: `nucleus-planner-ticket-${participantId}`,
        text: `Nucleus has registered you as the planner for a task it is running. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when no live task names you as its planner.` }),
      onFailure: { taskId: 'queue', kind: 'task_planner_ticket_unavailable' },
    }, route);
  }
}
