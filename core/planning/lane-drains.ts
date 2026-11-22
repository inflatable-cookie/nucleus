import { isOperatorOrigin, projectOwnerRoutable, type Lane, type LaneDocumentVersion, type LaneView, type Lead, type Notice, type Project, type ProjectPlan, type Task } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { evaluateDrains, type LaneDrainInput, type ProjectDrainInput } from "./lanes";

/** One finished task as the drain pass reads it: the last finish per project and the submitter an idle mark answers. */
export type FinishedDrainTask = {
  id: string;
  repoPath: string;
  repository: string | null;
  finishedAt: string;
  originAgentId: string;
};

/**
 * The store facts a drain pass reads and the writes it applies, each typed at the owner
 * that holds the rows. The pass decides routing, idle-plan re-versioning and notices; no
 * caller of this interface is a place where lane or plan policy lives.
 */
export interface LaneDrainStore {
  transaction<T>(work: () => T): T;
  projects(): Project[];
  projectKeyResolver(projects: Project[]): (task: Pick<Task, "repoPath" | "repository">) => string | null;
  projectByKey(key: string): Project | null;
  projectPlannerRecipient(project: Pick<Project, "planner"> | null | undefined): string | null;
  /** Persists one project's drain episode; null when the project row is gone. */
  setProjectDrain(key: string, drain: Project["drain"]): Project | null;
  uiTasks(): Task[];
  laneViews(): LaneView[];
  openLeads(): Lead[];
  plan(input: { project: string; version?: number }): ProjectPlan;
  /** Appends a plan version that ends an idle mark, keeping the acknowledged version in history. */
  appendPlanVersion(plan: ProjectPlan): ProjectPlan;
  laneDocument(key: string): LaneDocumentVersion | null;
  notices(taskId?: string): Notice[];
  putNotice(notice: Notice): void;
  /** Records one lane's drain episode; an unknown lane refuses rather than dropping the episode. */
  setLaneDrain(key: string, drain: Lane["drain"]): void;
  drainSettings(): { drainMinutes: number; escalationMinutes: number };
  finishedDrainTasks(): FinishedDrainTask[];
}

/**
 * Spec 041: one drain pass over every project's saved plans. A plan nobody saved starts
 * no episode; a stored episode still escalates by its timer. Episodes and notices land in one transaction, so a pass never leaves a
 * started episode without its prompt. The evaluation itself is `evaluateDrains`;
 * this pass only gathers its inputs from the store and applies its decisions.
 */
export class LaneDrainPass {
  constructor(private readonly store: LaneDrainStore) {}

  evaluate(at = Date.now()): void {
    const registered = this.store.projects();
    const projectKey = this.store.projectKeyResolver(registered);
    const byProject = new Map(registered.map(project => [project.key, project]));
    const recipients = new Map(registered.map(project => [project.key, this.store.projectPlannerRecipient(project)]));
    // A live responsible thread can receive prompts for a saved plan without a registration.
    const projects = registered.filter(project => recipients.get(project.key) || projectOwnerRoutable(project));
    if (!registered.length) return;
    this.store.transaction(() => {
      const tasks = this.store.uiTasks();
      const views = this.store.laneViews();
      const byKey = new Map(views.map(view => [view.key, view]));
      const leads = this.store.openLeads();
      const laneInputs: LaneDrainInput[] = [];
      const projectInputs: ProjectDrainInput[] = [];
      const claimed = new Set<string>();
      // Latest task finishes per project; finished tasks are not in uiTasks.
      // The general drain still counts any project task. An explicit idle mark
      // is answered only by its planner's submission or an operator submission.
      const lastFinished = new Map<string, string>();
      const idleSubmittedFinished = new Map<string, string>();
      for (const fact of this.store.finishedDrainTasks()) {
        const repository = fact.repository;
        const key = projectKey({ repoPath: fact.repoPath, repository: repository && normalizeRepositoryOrigin(repository) ? repository : null });
        const project = key ? byProject.get(key) : null;
        if (!key || !fact.finishedAt) continue;
        const finishedAt = fact.finishedAt;
        if (!lastFinished.has(key) || lastFinished.get(key)! < finishedAt) lastFinished.set(key, finishedAt);
        const submitter = fact.originAgentId;
        if (submitter === project!.planner?.agentId || isOperatorOrigin(submitter)) {
          if (!idleSubmittedFinished.has(key) || idleSubmittedFinished.get(key)! < finishedAt) idleSubmittedFinished.set(key, finishedAt);
        }
      }
      for (const project of registered.filter(project => !projects.includes(project) && project.drain)) this.store.setProjectDrain(project.key, null);
      for (const project of projects) {
        const read = this.store.plan({ project: project.key });
        // Only the saved order counts as “in a plan”; joined lanes wait behind “unplanned”.
        // A requested version returns exactly as saved, closed lanes included, so every step
        // re-checks that its lane is still open. A project nobody ever saved a plan for —
        // including the default per-repository project — has no roadmap and no owner, so it
        // is never prompted, never escalated, and never carries an episode (review 5402595790).
        let saved = read.version > 0 ? this.store.plan({ project: project.key, version: read.version }) : null;
        if (saved?.idle) {
          const eligibleFinish = idleSubmittedFinished.get(project.key);
          if (eligibleFinish && Date.parse(eligibleFinish) > Date.parse(saved.idle.at)) {
            // Keep the saved idle acknowledgement in history, and append the same
            // plan without it so the current mark visibly ends on eligible work.
            const { idle: _idle, ...planWithoutIdle } = saved;
            saved = this.store.appendPlanVersion({ ...planWithoutIdle, version: saved.version + 1, createdAt: new Date(at).toISOString() });
          }
        }
        if (!saved) continue;
        // Shared lanes belong to every saved project plan. Only lane-level notices
        // are deduplicated; each board still reads its complete roadmap.
        const entries = saved.entries;
        const openView = (key: string) => {
          const view = byKey.get(key);
          return view && (view.status === "active" || view.status === "paused") ? view : null;
        };
        const horizonStep = (horizon: "now" | "next") => entries.find(entry => entry.horizon === horizon && openView(entry.lane));
        for (const entry of entries) {
          const view = byKey.get(entry.lane);
          if (!view || claimed.has(entry.lane)) continue;
          claimed.add(entry.lane);
          laneInputs.push({
            key: view.key, title: view.title, aim: view.aim, drain: view.drain, status: view.status, lastActivityAt: view.lastActivityAt ?? view.updatedAt, keptAt: view.keep?.at ?? null,
            liveTasks: Object.values(view.liveByPhase).reduce((sum, count) => sum + count, 0),
            openLeads: leads.filter(lead => lead.lanes.includes(entry.lane)).length,
            plan: { project: project.key, projectName: project.name, owner: recipients.get(project.key) ?? "", doneWhen: entry.doneWhen ?? "" },
            outcomes: view.recentOutcomes.map(outcome => ({ title: outcome.title, outcome: outcome.outcome, prNumber: outcome.prNumber, finishedAt: outcome.finishedAt })),
          });
        }
        const topNowEntry = horizonStep("now"), firstNextEntry = horizonStep("next");
        const topNow = topNowEntry ? openView(topNowEntry.lane) : null;
        const firstNext = firstNextEntry ? openView(firstNextEntry.lane) : null;
        projectInputs.push({
          key: project.key, name: project.name, drain: project.drain, lastFinishedAt: lastFinished.get(project.key) ?? null,
          idleSubmittedFinishedAt: idleSubmittedFinished.get(project.key) ?? null, idleSince: saved.idle?.at ?? null,
          liveTasks: tasks.filter(task => !["done", "cancelled"].includes(task.phase) && !task.removedAt
            && projectKey({ repoPath: task.repoPath, repository: task.repository && normalizeRepositoryOrigin(task.repository) ? task.repository : null }) === project.key).length,
          topNow: topNow && topNowEntry ? {
            lane: topNowEntry.lane, title: topNow.title, aim: topNow.aim, doneWhen: topNowEntry.doneWhen ?? "",
            documentVersion: this.store.laneDocument(topNowEntry.lane)?.version ?? 0,
          } : null,
          firstNext: firstNext && firstNextEntry ? { lane: firstNextEntry.lane, title: firstNext.title, aim: firstNext.aim } : null,
          openLeads: topNowEntry ? leads.filter(lead => lead.lanes.includes(topNowEntry.lane)).map(lead => ({ id: lead.id, title: lead.title })) : [],
          owner: recipients.get(project.key) ?? "",
        });
      }
      // A lane no active project's saved plan names any more ends any open episode.
      for (const view of views) {
        if (claimed.has(view.key)) continue;
        laneInputs.push({ key: view.key, title: view.title, aim: view.aim, drain: view.drain, status: view.status,
          lastActivityAt: view.lastActivityAt ?? view.updatedAt, liveTasks: 0, openLeads: 0, plan: null, outcomes: [] });
      }
      const evaluation = evaluateDrains(laneInputs, projectInputs, this.store.drainSettings(), at);
      for (const [key, drain] of Object.entries(evaluation.lanes)) this.store.setLaneDrain(key, drain);
      for (const [key, drain] of Object.entries(evaluation.projects)) this.store.setProjectDrain(key, drain);
      for (const notice of evaluation.notices) {
        const existing = this.store.notices(notice.taskId).find(item => item.id === notice.id);
        if (existing) {
          if (existing.status === "pending" && existing.text !== notice.text) this.store.putNotice({ ...existing, text: notice.text });
          continue;
        }
        this.store.putNotice({ id: notice.id, taskId: notice.taskId, agentId: notice.agentId, recipientAgentId: notice.agentId, workspaceId: null,
          sources: [], originEntry: false, kind: notice.kind, status: "pending", error: "", text: notice.text });
      }
    });
  }
}
