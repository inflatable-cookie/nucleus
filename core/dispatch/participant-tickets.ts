import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatAgentId, parseAgentId } from '../../shared/agent-identity';
import type { Project } from '../../shared/contracts';
import type { Engine } from '../engine';
import { writeOwnedJson } from '../machine/owned-file.mjs';
import { digest, type Store } from '../store/store';

export const plannerTicketKey = (project: string) => `plannerParticipant:${project}`;
interface PlannerParticipant {
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

/** One owner-only identity ticket per planner assignment, delivered once through its host. */
export class PlannerParticipantTickets {
  private pending: Promise<void> | null = null;
  private requested = false;
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
  }

  private async issue(project: Project): Promise<void> {
    const planner = project.planner!;
    const generation = this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`);
    const qualified = parseAgentId(planner.agentId);
    const hostId = qualified?.hostId ?? await this.engine.identifyOriginHost(planner.agentId);
    if (!hostId || !this.engine.withHost(hostId, () => this.engine.hostAvailable(hostId))) return;
    const nativeAgentId = qualified?.nativeAgentId ?? planner.agentId;
    const participantId = randomUUID(), token = randomBytes(32).toString('hex');
    const directory = join(dirname(this.paths.helperPath), 'tickets');
    const path = join(directory, `participant-${participantId}.json`);
    const participant: PlannerParticipant = { participantId, projectKey: project.key, agentId: planner.agentId,
      setAt: planner.setAt, hostId, nativeAgentId, tokenHash: digest(token), path, delivery: 'intent' };
    const stillCurrent = () => {
      const current = this.engine.store.projectByKey(project.key)?.planner;
      return current?.agentId === planner.agentId && current.setAt === planner.setAt
        && this.engine.store.getMeta<string>(`plannerParticipantGeneration:${project.key}`) === generation;
    };
    if (!stillCurrent() || this.engine.store.getMeta(plannerTicketKey(project.key))) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeOwnedJson(path, { socketPath: this.paths.socketPath, participantId, token });
    this.engine.store.transaction(() => {
      if (!stillCurrent()) throw Error('Planner changed before ticket delivery');
      this.engine.store.setMeta(plannerTicketKey(project.key), participant);
      this.engine.store.setMeta(`plannerParticipantId:${participantId}`, project.key);
    });
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
  }
}
