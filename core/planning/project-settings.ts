import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import {
  projectSettingsSchema,
  repositoryMatchSpecificity,
  type Project,
  type ProjectQaRun,
  type ProjectSettings,
  type ProjectSettingsProblem,
  type ProjectSettingsQa,
  type RepositorySettings,
} from "../../shared/contracts";

export const PROJECT_SETTINGS_PROBLEMS = {
  plannerGone: "Planner thread is gone",
  noPlanner: "No planner",
  qaFailed: "Last QA failed",
} as const satisfies Record<string, ProjectSettingsProblem>;

export function projectSettingsProblems(input: {
  plannerId: string | undefined;
  plannerLive: boolean | null;
  latestQaFailed: boolean;
}): ProjectSettingsProblem[] {
  const problems: ProjectSettingsProblem[] = [];
  if (input.plannerId && input.plannerLive === false) problems.push(PROJECT_SETTINGS_PROBLEMS.plannerGone);
  else if (!input.plannerId) problems.push(PROJECT_SETTINGS_PROBLEMS.noPlanner);
  if (input.latestQaFailed) problems.push(PROJECT_SETTINGS_PROBLEMS.qaFailed);
  return problems;
}

function settingsForRepository(
  repo: Project["repositories"][number],
  rows: RepositorySettings[],
): RepositorySettings | null {
  const ranked = rows
    .map(row => ({ row, spec: repositoryMatchSpecificity(row, repo.path, repo.origin) }))
    .filter(entry => entry.spec > 0)
    .sort((a, b) => b.spec - a.spec || b.row.revision - a.row.revision);
  return ranked[0]?.row ?? null;
}

function qaKeysFor(project: Project): Set<string> {
  const keys = new Set<string>();
  for (const repo of project.repositories) {
    if (repo.origin) keys.add(repo.origin);
    if (repo.path) keys.add(repo.path);
  }
  return keys;
}

/** Origins and paths Settings uses to look up each project's latest QA. */
export function projectSettingsQaKeys(projects: readonly Project[]): string[] {
  const keys = new Set<string>();
  for (const project of projects) for (const key of qaKeysFor(project)) keys.add(key);
  return [...keys];
}

function latestQaFor(project: Project, runs: ProjectQaRun[]): ProjectSettingsQa | null {
  const keys = qaKeysFor(project);
  const match = runs.find(run => keys.has(run.key));
  return match ? { key: match.key, state: match.state, startedAt: match.startedAt, finishedAt: match.finishedAt } : null;
}

function anyLatestQaFailed(project: Project, runs: ProjectQaRun[]): boolean {
  const keys = qaKeysFor(project);
  return runs.some(run => keys.has(run.key) && run.state === "failed");
}

export function buildProjectSettings(input: {
  projects: Project[];
  repositories: RepositorySettings[];
  overrides: Record<string, number>;
  defaultSlots: number;
  liveAgentIds: ReadonlySet<string>;
  liveKnown: boolean;
  observedHostId?: string;
  latestQaRuns: ProjectQaRun[];
  /** Projects whose planner has no usable participant ticket yet. */
  plannerTicketPending?: ReadonlySet<string>;
}): ProjectSettings {
  return projectSettingsSchema.parse({
    defaultSlots: input.defaultSlots,
    projects: input.projects.map(project => {
      const override = Object.prototype.hasOwnProperty.call(input.overrides, project.key)
        ? input.overrides[project.key]! : null;
      const plannerId = project.planner?.agentId;
      const plannerHost = plannerId ? parseAgentId(plannerId)?.hostId : undefined;
      const plannerObserved = plannerHost ? input.observedHostId === plannerHost
        : !input.observedHostId || hostKindOf(input.observedHostId) === 'paseo';
      const plannerLive = !plannerId ? null : input.liveAgentIds.has(plannerId) ? true
        : input.liveKnown && plannerObserved ? false : null;
      const latestQa = latestQaFor(project, input.latestQaRuns);
      return {
        project,
        repositories: project.repositories.map(repo => ({
          repository: repo,
          primary: Boolean(
            repo.origin && project.primary.origin
              ? repo.origin === project.primary.origin
              : repo.path && repo.path === project.primary.path,
          ),
          settings: settingsForRepository(repo, input.repositories),
        })),
        slots: { value: override ?? input.defaultSlots, override },
        plannerLive,
        plannerTicket: !plannerId ? null : input.plannerTicketPending?.has(project.key) ? 'pending' : 'issued',
        latestQa,
        problems: projectSettingsProblems({
          plannerId,
          plannerLive,
          latestQaFailed: anyLatestQaFailed(project, input.latestQaRuns),
        }),
      };
    }),
  });
}
