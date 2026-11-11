import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatAgentId, parseAgentId } from '../../shared/agent-identity';
import type { Project, ProjectAgent } from '../../shared/contracts';
import type { Engine } from '../engine';
import { writeOwnedJson } from '../machine/owned-file.mjs';
import { digest, type Store } from '../store/store';

/** The pre-registry planner ticket, kept only so an already-delivered one is adopted, never reissued. */
export const plannerTicketKey = (project: string) => `plannerParticipant:${project}`;
/** One participant ticket per registered named agent. */
export const agentTicketKey = (project: string, name: string) => `projectAgentParticipant:${project}:${name}`;
const agentTicketIdKey = (participantId: string) => `projectAgentParticipantId:${participantId}`;
const AGENT_TICKET_PREFIX = 'projectAgentParticipant:';

interface ParticipantRecord {
  participantId: string;
  projectKey: string;
  name: string;
  agentId: string;
  hostId: string;
  nativeAgentId: string;
  tokenHash: string;
  path: string;
  delivery: 'intent' | 'delivered' | 'unknown';
}
interface LegacyPlannerParticipant {
  participantId: string;
  projectKey: string;
  agentId: string;
  setAt: string;
  hostId: string;
  nativeAgentId: string;
  tokenHash: string;
  path: string;
  delivery: 'intent' | 'delivered' | 'unknown';
}
export type CallerTicket = { taskId: string; runId: string } | { participantId: string };

/** A delegate prompt may name a registered ticket path without reading its credential. */
export function plannerParticipantTicketPath(store: Store, recipient: string, hostId?: string): string | undefined {
  const qualified = parseAgentId(recipient);
  const native = qualified?.nativeAgentId ?? recipient;
  const matchesHost = (recordHostId: string) => hostId ? recordHostId === hostId : !qualified || qualified.hostId === recordHostId;
  for (const project of store.projects()) {
    for (const agent of project.agents ?? []) {
      const record = store.getMeta<ParticipantRecord>(agentTicketKey(project.key, agent.name));
      if (record && record.agentId === agent.agentId && record.nativeAgentId === native && matchesHost(record.hostId)) return record.path;
    }
    // A planner assigned before the registry existed still names its delivered ticket.
    const legacy = store.getMeta<LegacyPlannerParticipant>(plannerTicketKey(project.key));
    if (legacy && legacy.nativeAgentId === native && project.planner?.agentId === legacy.agentId && matchesHost(legacy.hostId)) return legacy.path;
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
      const record = store.getMeta<ParticipantRecord>(agentTicketKey(scoped.projectKey, scoped.name));
      if (!agent || !record || record.participantId !== input.participantId
        || record.agentId !== agent.agentId || record.hostId !== agent.hostId || record.tokenHash !== digest(token))
        throw Error('Participant ticket is revoked or invalid');
      return { caller: formatAgentId(record.hostId, record.nativeAgentId), hostId: record.hostId, source: 'participant-ticket' as const };
    }
    // Pre-registry planner tickets stay valid until their assignment changes.
    const projectKey = store.getMeta<string>(`plannerParticipantId:${input.participantId}`);
    const participant = projectKey ? store.getMeta<LegacyPlannerParticipant>(plannerTicketKey(projectKey)) : null;
    const planner = projectKey ? store.projectByKey(projectKey)?.planner : null;
    if (!participant || participant.participantId !== input.participantId || participant.tokenHash !== digest(token)
      || !planner || planner.agentId !== participant.agentId || planner.setAt !== participant.setAt)
      throw Error('Participant ticket is revoked or invalid');
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
 * One owner-only identity ticket per named agent, delivered once through the
 * host it was registered on (task 1110, extending Spec 058's planner ticket).
 *
 * A ticket is issued for the entry's current thread and host, adopted when the
 * agent was already the project's fallback planner under the older planner
 * ticket, and revoked when the name is renamed, reassigned or unregistered.
 * After an unknown delivery nothing replays it: only a later registration change
 * issues a fresh ticket.
 */
export class ParticipantTickets {
  private pending: Promise<void> | null = null;
  private requested = false;
  constructor(private readonly engine: Engine, private readonly paths: { socketPath: string; helperPath: string }) {}

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

  private async reconcile(): Promise<void> {
    for (const project of this.engine.store.projects()) {
      try {
        // A planner set outside the RPC (a migration, a test fixture, a direct store write)
        // gains its registry entry here, using the host its identity proves.
        const unregistered = project.planner?.agentId && !(project.agents ?? []).some(agent => agent.agentId === project.planner!.agentId)
          ? project.planner.agentId : null;
        const hostId = unregistered
          ? parseAgentId(unregistered)?.hostId ?? await this.engine.identifyOriginHost(unregistered) ?? (this.engine.adapter as { hostId?: string }).hostId ?? null
          : (this.engine.adapter as { hostId?: string }).hostId ?? null;
        this.engine.store.ensureProjectFallbackAgent({ key: project.key, hostId });
      } catch (error) {
        this.engine.store.event(`project:${project.key}`, 'project_agent_register_unavailable', error instanceof Error ? error.message : String(error));
      }
      const current = this.engine.store.projectByKey(project.key);
      if (!current) continue;
      for (const agent of current.agents ?? []) {
        const record = this.engine.store.getMeta<ParticipantRecord>(agentTicketKey(current.key, agent.name));
        if (record && record.agentId === agent.agentId && record.hostId === agent.hostId) continue;
        try { await this.issue(current, agent); }
        catch (error) {
          // A proven pre-send lookup failure can be tried on the next host connect.
          // Once intent exists, even a thrown send is never replayed.
          this.engine.store.event(`project:${current.key}`, 'agent_ticket_unavailable', error instanceof Error ? error.message : String(error));
        }
      }
      this.prune(current);
    }
  }

  /**
   * A record for a name the project no longer registers, or for the previous
   * thread of a reassigned name, is revoked: its participant id stops resolving
   * and its on-disk credential no longer authenticates anything.
   */
  private prune(project: Project): void {
    const names = new Map((project.agents ?? []).map(agent => [agent.name, agent]));
    const records = this.engine.store.db.prepare(`SELECT key, value FROM meta WHERE key GLOB '${AGENT_TICKET_PREFIX}*'`)
      .all() as Array<{ key: string; value: string }>;
    for (const row of records) {
      const [projectKey, name] = splitTicketKey(row.key);
      if (!projectKey || projectKey !== project.key) continue;
      let record: ParticipantRecord | null = null;
      try { record = JSON.parse(row.value) as ParticipantRecord; } catch { record = null; }
      const agent = name ? names.get(name) : undefined;
      if (agent && record && record.participantId && record.agentId === agent.agentId) continue;
      this.engine.store.transaction(() => {
        this.engine.store.deleteMeta(row.key);
        if (record?.participantId) this.engine.store.deleteMeta(agentTicketIdKey(record.participantId));
      });
    }
  }

  private async issue(project: Project, agent: ProjectAgent): Promise<void> {
    const adopted = this.adoptLegacy(project, agent);
    if (adopted) return;
    if (!this.engine.withHost(agent.hostId, () => this.engine.hostAvailable(agent.hostId))) return;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const directory = join(dirname(this.paths.helperPath), 'tickets');
    const path = join(directory, `participant-${participantId}.json`);
    const record: ParticipantRecord = {
      participantId, projectKey: project.key, name: agent.name, agentId: agent.agentId, hostId: agent.hostId,
      nativeAgentId: parseAgentId(agent.agentId)?.nativeAgentId ?? agent.agentId,
      tokenHash: digest(token), path, delivery: 'intent',
    };
    const stillCurrent = () => {
      const entry = (this.engine.store.projectByKey(project.key)?.agents ?? []).find(candidate => candidate.name === agent.name);
      return entry?.agentId === agent.agentId && entry.hostId === agent.hostId && entry.registeredAt === agent.registeredAt;
    };
    if (!stillCurrent()) return;
    const previous = this.engine.store.getMeta<ParticipantRecord>(agentTicketKey(project.key, agent.name));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillCurrent()) throw Error('Agent registration changed before ticket delivery');
      this.engine.store.setMeta(agentTicketKey(project.key, agent.name), record);
      this.engine.store.setMeta(agentTicketIdKey(participantId), { projectKey: project.key, name: agent.name });
      if (previous?.participantId && previous.participantId !== participantId)
        this.engine.store.deleteMeta(agentTicketIdKey(previous.participantId));
      // The fallback planner's older ticket is superseded by this registration.
      if (this.engine.store.projectByKey(project.key)?.planner?.agentId === agent.agentId) {
        const legacy = this.engine.store.getMeta<LegacyPlannerParticipant>(plannerTicketKey(project.key));
        if (legacy) {
          this.engine.store.deleteMeta(plannerTicketKey(project.key));
          this.engine.store.deleteMeta(`plannerParticipantId:${legacy.participantId}`);
        }
      }
    });
    try {
      await this.engine.withHost(agent.hostId, () => this.engine.host.sendMessage(record.nativeAgentId, {
        messageId: `nucleus-agent-ticket-${participantId}`,
        text: `Nucleus has registered you as "${agent.name}" for ${project.name}: ${agent.purpose}. Your participant ticket identifies this thread on any host. For Nucleus CLI commands, set NUCLEUS_TICKET=${JSON.stringify(path)}. It takes priority over host identity and is revoked when this registration is renamed, reassigned or unregistered.`,
      }));
      const stored = this.engine.store.getMeta<ParticipantRecord>(agentTicketKey(project.key, agent.name));
      if (stored?.participantId === participantId) this.engine.store.setMeta(agentTicketKey(project.key, agent.name), { ...record, delivery: 'delivered' });
    } catch (error) {
      const stored = this.engine.store.getMeta<ParticipantRecord>(agentTicketKey(project.key, agent.name));
      if (stored?.participantId === participantId) this.engine.store.setMeta(agentTicketKey(project.key, agent.name), { ...record, delivery: 'unknown' });
      throw error;
    }
  }

  /**
   * An agent that was already this project's fallback planner keeps the ticket
   * Its assignment delivered, re-keyed under its name, so a live thread never
   * loses its identity across the upgrade.
   */
  private adoptLegacy(project: Project, agent: ProjectAgent): boolean {
    const planner = project.planner;
    const legacy = this.engine.store.getMeta<LegacyPlannerParticipant>(plannerTicketKey(project.key));
    if (!legacy || planner?.agentId !== agent.agentId || legacy.agentId !== agent.agentId
      || legacy.hostId !== agent.hostId || planner.setAt !== legacy.setAt) return false;
    const record: ParticipantRecord = {
      participantId: legacy.participantId, projectKey: project.key, name: agent.name, agentId: agent.agentId,
      hostId: legacy.hostId, nativeAgentId: legacy.nativeAgentId, tokenHash: legacy.tokenHash, path: legacy.path, delivery: legacy.delivery,
    };
    this.engine.store.transaction(() => {
      this.engine.store.setMeta(agentTicketKey(project.key, agent.name), record);
      this.engine.store.setMeta(agentTicketIdKey(record.participantId), { projectKey: project.key, name: agent.name });
      this.engine.store.deleteMeta(plannerTicketKey(project.key));
      this.engine.store.deleteMeta(`plannerParticipantId:${legacy.participantId}`);
    });
    return true;
  }
}

function splitTicketKey(key: string): [string, string] | [null, null] {
  const rest = key.slice(AGENT_TICKET_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return [null, null];
  return [rest.slice(0, separator), rest.slice(separator + 1)];
}
