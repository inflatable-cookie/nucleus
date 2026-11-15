import { projectPlanSchema, projectQaRunSchema, type Project, type ProjectMergeCheck, type ProjectMergeCheckInput, type ProjectMergeInput, type ProjectMergeResult, type ProjectPlan, type ProjectRemovalBlocker, type ProjectTombstone } from "../../shared/contracts";
import { projectRemovalBlockerText, projectRepositoryMatches } from "../../shared/project-removal";
import { now, StoreCore } from "./store-core";
import { type StoreProjectRemoval } from "./store-project-removal";
import { type StoreProjectRegistry } from "./store-project-registry";

/**
 * The plan entries a source's saved order adds to a target's: the target's own order
 * first, then each source lane the target does not already order, capped at 200.
 * The target's idle mark survives only while no now or next lane joins. Every
 * move of plan entries uses this one rule.
 */
export function joinPlanEntries(into: ProjectPlan | null, from: ProjectPlan): { entries: ProjectPlan["entries"]; idle?: ProjectPlan["idle"] } {
  const known = new Set((into?.entries ?? []).map(entry => entry.lane));
  const entries = [...(into?.entries ?? []), ...from.entries.filter(entry => !known.has(entry.lane))].slice(0, 200);
  const idle = into?.idle && !entries.some(entry => entry.horizon === "now" || entry.horizon === "next") ? { idle: into.idle } : {};
  return { entries, ...idle };
}

interface MergeAccess {
  storedPlan(project: string, version?: number): ProjectPlan | null;
}

/**
 * Moving a project, or one of its members, into another project as one write. The
 * target keeps its name, planner, slots and primary; records attached to the moving
 * repositories follow them; a source left empty is retired and its plan joins the target.
 */
export class StoreProjectMerge {
  constructor(private readonly core: StoreCore, private readonly registry: StoreProjectRegistry,
    private readonly removal: StoreProjectRemoval, private readonly access: MergeAccess) {}
  private get db() { return this.core.db; }

  /**
   * nucleus#984: what a move would refuse on, and what it carries along. A move
   * takes every record attached to the moving repositories with them (tasks,
   * leads, papercuts, lanes, drafts, submissions, decisions, QA history), so
   * those are `carried`, not blockers. Only state that can't change projects
   * mid-flight blocks: a queued or running project QA, or an in-flight
   * repository re-key, on a moving repository.
   */
  mergeCheck(input: ProjectMergeCheckInput): ProjectMergeCheck {
    const source = this.registry.projectByKey(input.source);
    if (!source) throw new Error(`Unknown project ${input.source}`);
    const moving = input.repository === undefined ? source : { ...source, repositories: [this.registry.projectMember(source, input.repository)] };
    return { blockers: this.mergeBlockers(moving), carried: this.removal.removalBlockers(source.key, input.repository) };
  }

  mergeBlockers(moving: Project): ProjectRemovalBlocker[] {
    const label = (repo: { origin?: string | null; path?: string | null }) => repo.origin ?? repo.path ?? "repository";
    const qa = this.db.prepare("SELECT data FROM project_qa_runs WHERE json_extract(data,'$.state') IN ('queued','running') OR json_extract(data,'$.finishedAt') IS NULL").all()
      .map(row => projectQaRunSchema.parse(JSON.parse(String(row.data)))).filter(run => projectRepositoryMatches(moving, run.repository.path, run.repository.origin));
    const rekeys = this.db.prepare("SELECT payload FROM operations WHERE kind='repository_rekey' AND state IN ('pending','running','needs_attention') ORDER BY rowid").all()
      .map(row => (JSON.parse(String(row.payload)) as { input?: { source?: string } } | null)?.input?.source).filter((source): source is string => Boolean(source && projectRepositoryMatches(moving, source, source)));
    const blockers: ProjectRemovalBlocker[] = [];
    if (qa.length) blockers.push({ kind: "qa", label: "project QA run", names: qa.map(run => `${label(run.repository)} ${run.state}`) });
    if (rekeys.length) blockers.push({ kind: "operation", label: "repository re-key", names: rekeys });
    return blockers;
  }

  /**
   * nucleus#969: move a project, or one of its members, into another project as
   * one write. The target keeps its name, planner, slots and primary. Records
   * attached to the moving repositories follow them unchanged (nucleus#984); a
   * source left empty is removed, its saved plan entries join the end of the
   * target's plan and its slot override goes. Only `mergeBlockers` refuse. A
   * repository is never in two projects.
   */
  mergeProject(input: ProjectMergeInput): ProjectMergeResult {
    return this.core.transaction(() => {
      if (input.source === input.target) throw new Error("Choose a different project to move into");
      const source = this.registry.projectByKey(input.source), target = this.registry.projectByKey(input.target);
      if (!source) throw new Error(`Unknown project ${input.source}`);
      if (!target) throw new Error(`Unknown project ${input.target}`);
      if (source.version !== input.versions.source) throw new Error(`Stale project version for ${source.key}: expected ${source.version}`);
      if (target.version !== input.versions.target) throw new Error(`Stale project version for ${target.key}: expected ${target.version}`);
      const moving = input.repository === undefined ? source.repositories : [this.registry.projectMember(source, input.repository)];
      const blockers = this.mergeBlockers({ ...source, repositories: moving });
      if (blockers.length) throw new Error(`${source.name} cannot move into ${target.name}: ${projectRemovalBlockerText(blockers)}`);
      const identity = (repo: Project["repositories"][number]) => repo.origin ?? repo.path;
      const rest = source.repositories.filter(repo => !moving.some(moved => identity(moved) === identity(repo)));
      let kept: Project | null = null, tombstone: ProjectTombstone | null = null;
      if (rest.length) {
        if (!rest.some(repo => identity(repo) === identity(source.primary)))
          throw new Error(`Name another primary repository in ${source.name} before moving its current primary`);
        kept = this.registry.upsertProject({ key: source.key, name: source.name, repositories: rest, ...(rest.length > 1 ? { primary: source.primary } : {}) });
      } else if (!this.registry.isDefaultProject(source)) {
        this.db.prepare("DELETE FROM projects WHERE key=?").run(source.key);
      }
      const members = [...target.repositories, ...moving.filter(repo => !target.repositories.some(member => identity(member) === identity(repo)))];
      const project = this.registry.upsertProject({ key: target.key, name: target.name, repositories: members, primary: target.primary });
      if (!rest.length && !this.registry.isDefaultProject(source)) {
        this.mergePlanInto(source.key, target.key);
        tombstone = this.removal.retireProject(source, input.reason);
      }
      for (const repo of moving) {
        const holders = this.registry.projects().filter(candidate => projectRepositoryMatches(candidate, repo.path, repo.origin));
        if (holders.length !== 1) throw new Error(`Repository ${identity(repo)} would be in ${holders.length} projects; nothing changed`);
      }
      return { project, source: kept, tombstone };
    });
  }

  /**
   * nucleus#984: a removed source's saved plan order joins the end of the
   * target's, skipping lanes the target already orders, as one new target plan
   * version. The target's idle mark stays only while no now or next lane joins.
   */
  mergePlanInto(source: string, target: string): void {
    const from = this.access.storedPlan(source);
    if (!from?.entries.length) return;
    const into = this.access.storedPlan(target);
    const joined = joinPlanEntries(into, from);
    if (joined.entries.length === (into?.entries.length ?? 0)) return;
    const version = (into?.version ?? 0) + 1;
    this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(target, version,
      JSON.stringify(projectPlanSchema.parse({ project: target, version, author: "operator (project management)", createdAt: now(), ...joined })));
  }
}
