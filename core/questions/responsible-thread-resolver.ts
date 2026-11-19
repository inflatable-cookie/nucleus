import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseAgentId, sameCallerIdentity } from '../../shared/agent-identity';
import { ownerCandidateKind } from '../../shared/owner-candidate-kind';
import { isOperatorOrigin, taskOwner, type Project, type Run, type Task } from '../../shared/contracts';
import type { HostLiveAgent } from '../../shared/host';
import { observationTimeout } from '../recovery/observation-timeout';
import { ResponsibleThreadCache, type ResponsibleThreadFact, type ResponsibleShortlist } from './responsible-thread-cache';

const git = promisify(execFile);

export interface ResponsibleThreadResolverPorts {
  hostIds(): readonly string[];
  hostOnline(hostId: string): boolean;
  inventory(hostId: string): Promise<HostLiveAgent[]>;
  tasks(): Task[];
  runs(): Run[];
  projectKeyResolver(projects?: Project[]): (task: Task) => string | null;
}

interface ResponsibleTaskIndex {
  tasks: Task[];
  runs: Run[];
  byProject: ReadonlyMap<string, Task[]>;
  gitRoots: Map<string, Promise<string | null>>;
}

function inDirectory(directory: string, root: string): boolean {
  const path = relative(resolve(root), resolve(directory));
  return path === '' || (!path.startsWith('..' + '/') && path !== '..' && !isAbsolute(path));
}

/** The host a qualified identity proves, when it is recorded qualified. */
function identityHost(id: string | null | undefined): string | null {
  if (!id) return null;
  try { return parseAgentId(id)?.hostId ?? null; } catch { return null; }
}

/** A checkout and any of its linked worktrees share a Git common directory. */
async function commonDirectory(directory: string): Promise<string | null> {
  try {
    const { stdout } = await git('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 1000, maxBuffer: 4096 });
    return resolve(stdout.trim());
  } catch { return null; }
}

export class ResponsibleThreadResolver {
  readonly cache = new ResponsibleThreadCache();
  private readonly membership = new Map<string, string>();
  private readonly activity = new Map<string, string>();
  private readonly inventories = new Map<string, Promise<HostLiveAgent[]>>();
  private inventory(hostId: string): Promise<HostLiveAgent[]> {
    const pending = this.inventories.get(hostId);
    if (pending) return pending;
    const read = observationTimeout(this.ports.inventory(hostId), 'Responsible host inventory timed out', 1800)
      .finally(() => { if (this.inventories.get(hostId) === read) this.inventories.delete(hostId); });
    this.inventories.set(hostId, read);
    return read;
  }
  recordActivity(agentId: string): void {
    this.activity.set(agentId, new Date().toISOString());
    if (this.activity.size > 10_000) this.activity.delete(this.activity.keys().next().value!);
    this.cache.invalidateMatching(agentId);
  }
  constructor(private readonly ports: ResponsibleThreadResolverPorts) {}

  taskIndex(projects?: Project[]): ResponsibleTaskIndex {
    const tasks = this.ports.tasks();
    const keyOf = this.ports.projectKeyResolver(projects);
    const byProject = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = keyOf(task);
      if (!key) continue;
      const group = byProject.get(key);
      if (group) group.push(task);
      else byProject.set(key, [task]);
    }
    return { tasks, runs: this.ports.runs(), byProject, gitRoots: new Map() };
  }

  async resolve(project: Project, excludedHosts?: ReadonlySet<string>, index = this.taskIndex()): Promise<ResponsibleShortlist | null> {
    const { tasks, runs, gitRoots } = index;
    const projectTasks = index.byProject.get(project.key) ?? [];
    const online = this.ports.hostIds().filter(id => !excludedHosts?.has(id) && this.ports.hostOnline(id)).sort();
    // A host leaving or a new dispatching/owning thread changes the shortlist
    // immediately, including when an earlier host pass is still in flight.
    const fingerprint = JSON.stringify([online, project.repositories, project.planner?.agentId,
      (project.agents ?? []).map(agent => [agent.agentId, agent.hostId]),
      projectTasks.map(task => [task.id, task.plannerAgentId, task.originAgentId, task.notificationAgentId, task.originHostId])]);
    if (this.membership.has(project.key) && this.membership.get(project.key) !== fingerprint)
      this.cache.invalidate(project.key);
    this.membership.set(project.key, fingerprint);
    const hosts = online.map(id => ({
      id,
      inventory: async () => {
        const agents = await this.inventory(id);
        const roots = project.repositories.map(repo => repo.path).filter(Boolean);
        const gitRoot = (path: string) => {
          let result = gitRoots.get(path);
          if (!result) { result = commonDirectory(path); gitRoots.set(path, result); }
          return result;
        };
        const registeredIds = [project.planner?.agentId ?? null,
          ...(project.agents ?? []).map(agent => agent.agentId)].filter((value): value is string => Boolean(value));
        const namedIds = registeredIds.filter(value => value !== project.planner?.agentId);
        return Promise.all(agents.map(async (agent): Promise<ResponsibleThreadFact> => {
          const matches = (value: string | null | undefined, host: string | null | undefined) =>
            sameCallerIdentity(value, agent.id, host, id);
          // A registered identity is matched by the host its own qualified id
          // proves, so a Paseo, T3 or BB registration is recognised as live on
          // that host and is never read through a stale recorded host id.
          const registered = (value: string | null | undefined) =>
            Boolean(value) && sameCallerIdentity(value, agent.id, identityHost(value), id);
          const taskRole = ownerCandidateKind(agent.labels) !== 'planner'
            || tasks.some(task => matches(task.agentId, task.hostId))
            || runs.some(run => matches(run.agentId, run.hostId));
          const owned = projectTasks.filter(task =>
            matches(task.plannerAgentId, task.originHostId)
            || (!isOperatorOrigin(taskOwner(task)) && matches(taskOwner(task), task.originHostId)));
          const registeredPlanner = registered(project.planner?.agentId);
          const registeredAgent = !registeredPlanner && namedIds.some(value => registered(value));
          const direct = [agent.directory, agent.repositoryRoot].some(path => path && roots.some(root => inDirectory(path, root)));
          let linked = false;
          if (!direct && agent.directory && roots.length) {
            const [candidate, ...repositories] = await Promise.all([gitRoot(agent.directory), ...roots.map(gitRoot)]);
            linked = !!candidate && repositories.includes(candidate);
          }
          const calls = [...this.activity].filter(([caller]) => matches(caller, null)).map(([, at]) => at);
          const lastInteraction = [agent.updatedAt, ...calls, ...owned.map(task => task.createdAt)].filter((date): date is string => !!date).sort().at(-1) ?? null;
          return { nativeId: agent.id, registeredPlanner, registeredAgent,
            dispatcher: owned.length > 0, repositoryWorker: Boolean(direct || linked),
            taskRole, closed: false, lastInteraction };
        }));
      },
    }));
    return this.cache.resolve(project.key, hosts);
  }
}
