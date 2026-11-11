import type { Task } from "../../shared/contracts";
import { holdsOf } from "../../shared/contracts";
import { startsNoRuns } from "../closeout/queue-drain";
import { LANE_PRIORITY_TASK } from "./lane-priorities";
import type { Engine } from '../engine';

export type PrerequisiteReleasesContext = Pick<Engine, 'cleanContext' | 'pendingPrerequisiteReleases' | 'prerequisiteReleaseWork' | 'refreshCheckoutSiblings' | 'scheduleLane' | 'stopped' | 'store' | 'wakeRepository' | 'wakeTask'>;

export class PrerequisiteReleases {
  readonly pendingPrerequisiteReleases = new Set<string>();
  prerequisiteReleaseWork: Promise<void> | null = null;
  constructor(readonly context: PrerequisiteReleasesContext) {}
  flushPrerequisiteReleases(): Promise<void> {
    if (startsNoRuns(this.context.store, this.context.stopped)) return Promise.resolve();
    if (this.context.prerequisiteReleaseWork) return this.context.prerequisiteReleaseWork;
    const run = async () => {
      while (this.context.pendingPrerequisiteReleases.size && !startsNoRuns(this.context.store, this.context.stopped)) {
        const ids = [...this.context.pendingPrerequisiteReleases];
        for (const id of ids) this.context.pendingPrerequisiteReleases.delete(id);
        const repositories = new Set<string>();
        const tasksToWake = new Set<string>();
        await Promise.all(ids.map(id => this.context.scheduleLane(`task:${id}`, LANE_PRIORITY_TASK, async () => {
          if (startsNoRuns(this.context.store, this.context.stopped)) { this.context.pendingPrerequisiteReleases.add(id); return; }
          let task: Task;
          try { task = this.context.store.task(id); } catch { return; }
          if (task.removedAt || ['done', 'cancelled'].includes(task.phase)) return;
          if (task.phase !== 'queued') { tasksToWake.add(id); return; }
          if (!this.context.store.dependencyWait(task) && task.dependsOn.length && !this.context.store.prerequisiteReleaseRefreshed(id)) {
            await this.context.refreshCheckoutSiblings(task, 'prerequisite_release');
            this.context.store.event(id, 'prerequisite_release_refreshed', 'checkout siblings refreshed on prerequisite release');
          }
          const fences = holdsOf(task);
          if (task.holdUntil || fences.dispatch?.until || fences.merge?.until) tasksToWake.add(id);
          repositories.add(task.repoPath);
        }).catch(() => {})));
        if (!startsNoRuns(this.context.store)) this.context.cleanContext(() => {
          for (const id of tasksToWake) void this.context.cleanContext(() => this.context.wakeTask(id));
          for (const repo of repositories) void this.context.cleanContext(() => this.context.wakeRepository(repo));
        });
      }
    };
    this.context.prerequisiteReleaseWork = run().finally(() => { this.context.prerequisiteReleaseWork = null; });
    return this.context.prerequisiteReleaseWork;
  }
}
