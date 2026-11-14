import type { Task } from "../../shared/contracts";
import {
  DEFAULT_HOST_OUTAGE_NOTICE_MINUTES, HOST_OUTAGES_META_KEY, hostOutageNoticeId, hostOutagesSchema,
  outageDuration, type HostOutage, type HostOutages as HostOutageRecord,
} from "../../shared/host-outage";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { now, type Store } from "../store/store";

/** How many waiting tasks one notice lists before it names the rest as a count. */
export const HOST_OUTAGE_NOTICE_TASK_LIMIT = 10;

const isLive = (task: Task) => !task.removedAt && task.phase !== "done" && task.phase !== "cancelled";

/**
 * The durable record of hosts that went away mid-session (Tom, 2026-11-14; T3
 * lane document v18, host dropout option 1: wait). It owns three facts: when an
 * outage began, whether its one long-outage notice has gone out, and the
 * project-level notice that represents it.
 *
 * The record is meta (never a task version), so opening or closing an outage
 * never makes an owner's control sent at the version it read stale. A host with
 * no entry is online; the first pass that sees it unavailable opens one entry
 * and every later pass reuses its start, including after a service restart
 * during the outage.
 */
export class HostOutages {
  constructor(private readonly store: Store) {}

  private read(): HostOutageRecord {
    try {
      const raw = this.store.getMeta<unknown>(HOST_OUTAGES_META_KEY);
      if (raw === undefined) return {};
      return hostOutagesSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch { return {}; }
  }

  private write(value: HostOutageRecord) {
    this.store.setMeta(HOST_OUTAGES_META_KEY, value);
  }

  /** Every outage still open, keyed by host id. */
  open(): HostOutageRecord { return this.read(); }

  /** The open outage for one host, or null while it is online. */
  current(hostId: string): HostOutage | null { return this.read()[hostId] ?? null; }

  /**
   * Record the availability this pass observed. The first offline observation
   * opens the outage at that time; a return closes it so the next outage gets a
   * fresh start and its own notice. Unchanged observations write nothing.
   */
  observe(hostId: string, online: boolean, at = now()): HostOutage | null {
    const record = this.read();
    const existing = record[hostId] ?? null;
    if (online) {
      if (!existing) return null;
      const next = { ...record };
      delete next[hostId];
      this.write(next);
      return null;
    }
    if (existing) return existing;
    const outage: HostOutage = { since: at, notifiedProjects: {} };
    this.write({ ...record, [hostId]: outage });
    return outage;
  }

  /**
   * Once a host has been unavailable past the dispatch-limits bound, tell each
   * affected project's planner once: the host, when it went offline, and the
   * tasks waiting on it. Tracking is per project and durable on the outage
   * (nucleus#1198 review), so:
   *
   * - a project that becomes affected after an earlier project was told still
   *   hears once for the same outage;
   * - a project whose planner was not resolvable at an earlier pass is retried on
   *   later ones instead of being marked as told;
   * - the same project never hears twice for one outage, and the notice itself is
   *   never resent after an uncertain delivery (its recorded intent covers that).
   *
   * Every live task on the unavailable host is listed, whatever stop it also
   * carries: an owner-facing stop does not stop the host from being the reason
   * nothing moves.
   */
  raiseNotices(at = Date.now()): string[] {
    const boundMs = (this.store.getMeta<number>("hostOutageNoticeMinutes") ?? DEFAULT_HOST_OUTAGE_NOTICE_MINUTES) * 60_000;
    const record = this.read();
    const due = Object.entries(record).filter(([, outage]) => {
      const since = Date.parse(outage.since);
      return Number.isFinite(since) && at - since >= boundMs;
    });
    if (!due.length) return [];
    const created: string[] = [];
    this.store.transaction(() => {
      const latest = this.read();
      for (const [hostId, outage] of due) {
        const current = latest[hostId];
        if (!current || current.since !== outage.since) continue;
        const waiting = this.store.tasks().filter(task => task.hostId === hostId && isLive(task));
        let changed = false;
        for (const [projectKey, tasks] of this.groupByProject(waiting)) {
          if (current.notifiedProjects[projectKey]) continue;
          const project = this.store.projectByKey(projectKey);
          const planner = this.store.projectPlannerRecipient(project);
          // No recipient yet: retry next pass, so a project that gains a planner
          // during the same outage still hears once.
          if (!planner) continue;
          const id = hostOutageNoticeId(hostId, projectKey, outage.since);
          this.store.putNotice({
            id, taskId: `project:${projectKey}`, agentId: planner, recipientAgentId: planner,
            workspaceId: null, sources: [], originEntry: false, kind: "host_outage", status: "pending",
            error: "", text: hostOutageNoticeText({ hostId, since: outage.since, projectName: project?.name ?? projectKey, tasks, at }),
          });
          current.notifiedProjects[projectKey] = id;
          created.push(id);
          changed = true;
        }
        if (changed) this.write({ ...latest });
      }
    });
    return created;
  }

  /** The waiting tasks grouped by the project that owns them, newest first. */
  private groupByProject(tasks: readonly Task[]): Map<string, Task[]> {
    const projects = this.store.projects();
    const keyOf = this.store.projectKeyResolver(projects);
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = keyOf(task) ?? this.store.projectFor(task.repoPath, task.repository ? normalizeRepositoryOrigin(task.repository) : null)?.key;
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    return groups;
  }
}

/** The one notice a project's planner receives for an outage past the bound. */
export function hostOutageNoticeText(facts: { hostId: string; since: string; projectName: string; tasks: readonly Task[]; at: number }): string {
  const listed = facts.tasks.slice(0, HOST_OUTAGE_NOTICE_TASK_LIMIT).map(task => {
    const reference = task.reference || `#${String(task.number).padStart(3, "0")}`;
    return `${reference} (${task.phase}, ${task.title})`;
  });
  const remainder = facts.tasks.length - listed.length;
  const rest = remainder > 0 ? `, and ${remainder} more` : "";
  return `Host ${facts.hostId} in project ${facts.projectName} has been unavailable since ${facts.since} (${outageDuration(facts.since, facts.at)}). `
    + `${facts.tasks.length} task${facts.tasks.length === 1 ? "" : "s"} wait${facts.tasks.length === 1 ? "s" : ""} on it: ${listed.join(", ")}${rest}. `
    + "Nucleus sends nothing to that host while it is away, spends no budget on the wait and resumes each task on the same host and threads when it returns; moving one stays an owner decision.";
}
