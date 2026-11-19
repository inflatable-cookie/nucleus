import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve } from 'node:path';
import { sameCallerIdentity } from '../../shared/agent-identity';
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
  projectFor(path: string, origin: string | null): Project | null;
}

function inDirectory(directory: string, root: string): boolean {
  const path = relative(resolve(root), resolve(directory));
  return path === '' || (!path.startsWith('..' + '/') && path !== '..' && !isAbsolute(path));
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
    this.cache.invalidateAll();
  }
  constructor(private readonly ports: ResponsibleThreadResolverPorts) {}

  async resolve(project: Project, excludedHosts: ReadonlySet<string> = new Set()): Promise<ResponsibleShortlist> {
    const tasks = this.ports.tasks();
    const runs = this.ports.runs();
    const projectTasks = tasks.filter(task => this.ports.projectFor(task.repoPath, task.repository ?? null)?.key === project.key);
    const online = this.ports.hostIds().filter(id => !excludedHosts.has(id) && this.ports.hostOnline(id)).sort();
    // A host leaving or a new dispatching/owning thread changes the shortlist
    // immediately, including when an earlier host pass is still in flight.
    const fingerprint = JSON.stringify([online, project.planner?.agentId,
      projectTasks.map(task => [task.id, task.plannerAgentId, task.originAgentId, task.notificationAgentId, task.originHostId])]);
    if (this.membership.has(project.key) && this.membership.get(project.key) !== fingerprint)
      this.cache.invalidate(project.key);
    this.membership.set(project.key, fingerprint);
    const hosts = online.map(id => ({
      id,
      inventory: async () => {
        const agents = await this.inventory(id);
        const roots = project.repositories.map(repo => repo.path).filter(Boolean);
        const common = new Map<string, Promise<string | null>>();
        const gitRoot = (path: string) => {
          let result = common.get(path);
          if (!result) { result = commonDirectory(path); common.set(path, result); }
          return result;
        };
        return Promise.all(agents.map(async (agent): Promise<ResponsibleThreadFact> => {
          const matches = (value: string | null | undefined, host: string | null | undefined) =>
            sameCallerIdentity(value, agent.id, host, id);
          const taskRole = ownerCandidateKind(agent.labels) !== 'planner'
            || tasks.some(task => matches(task.agentId, task.hostId))
            || runs.some(run => matches(run.agentId, run.hostId));
          const owned = projectTasks.filter(task =>
            matches(task.plannerAgentId, task.originHostId)
            || (!isOperatorOrigin(taskOwner(task)) && matches(taskOwner(task), task.originHostId)));
          const hint = matches(project.planner?.agentId, null);
          const direct = [agent.directory, agent.repositoryRoot].some(path => path && roots.some(root => inDirectory(path, root)));
          let linked = false;
          if (!direct && agent.directory && roots.length) {
            const [candidate, ...repositories] = await Promise.all([gitRoot(agent.directory), ...roots.map(gitRoot)]);
            linked = !!candidate && repositories.includes(candidate);
          }
          const calls = [...this.activity].filter(([caller]) => matches(caller, null)).map(([, at]) => at);
          const lastInteraction = [agent.updatedAt, ...calls, ...owned.map(task => task.createdAt)].filter((date): date is string => !!date).sort().at(-1) ?? null;
          return { nativeId: agent.id, belongsToProject: Boolean(direct || linked || owned.length || hint), taskRole, closed: false, registeredHint: hint, lastInteraction };
        }));
      },
    }));
    return this.cache.resolve(project.key, hosts);
  }
}
