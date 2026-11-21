import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import {
  projectSettingsSchema,
  repositoryMatchSpecificity,
  type Project,
  type ProjectSettings,
  type RepositorySettings,
} from "../../shared/contracts";

function settingsForRepository(
  repo: Project["repositories"][number],
  rows: RepositorySettings[],
): RepositorySettings | null {
  const ranked = rows
    .map((row) => ({
      row,
      spec: repositoryMatchSpecificity(row, repo.path, repo.origin),
    }))
    .filter((entry) => entry.spec > 0)
    .sort((a, b) => b.spec - a.spec || b.row.revision - a.row.revision);
  return ranked[0]?.row ?? null;
}

export function buildProjectSettings(input: {
  projects: Project[];
  responsibleThreads?: Record<string, { thread: import("../questions/responsible-thread-cache").ResponsibleThread | null; cacheAgeMs: number; shortlist: import("../questions/responsible-thread-cache").ResponsibleCandidate[] } | undefined>;
  repositories: RepositorySettings[];
  overrides: Record<string, number>;
  defaultSlots: number;
  liveAgentIds: ReadonlySet<string>;
  liveKnown: boolean;
  observedHostId?: string;
  /** Task 1110: each project's named agents with live state, read once for the page. */
  agents?: Record<string, import("../../shared/contracts").ProjectAgentView[]>;
  /** Projects whose planner has no usable participant ticket yet. */
  plannerTicketPending?: ReadonlySet<string>;
  plannerRoutingIssues?: ReadonlyMap<string, string | undefined>;
}): ProjectSettings {
  return projectSettingsSchema.parse({
    defaultSlots: input.defaultSlots,
    projects: input.projects.map((project) => {
      const override = Object.prototype.hasOwnProperty.call(
        input.overrides,
        project.key,
      )
        ? input.overrides[project.key]!
        : null;
      const plannerId = project.planner?.agentId;
      const plannerHost = plannerId
        ? parseAgentId(plannerId)?.hostId
        : undefined;
      const plannerObserved = plannerHost
        ? input.observedHostId === plannerHost
        : !input.observedHostId || hostKindOf(input.observedHostId) === "paseo";
      const plannerRoutingIssue = input.plannerRoutingIssues?.get(project.key);
      const plannerLive =
        !plannerId || plannerRoutingIssue
          ? null
          : input.liveAgentIds.has(plannerId)
            ? true
            : input.liveKnown && plannerObserved
              ? false
              : null;
      return {
        project,
        repositories: project.repositories.map((repo) => ({
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
        ...(input.responsibleThreads?.[project.key] ? { responsibleThread: input.responsibleThreads[project.key] } : {}),
        agents: input.agents?.[project.key] ?? [],
        plannerTicket: !plannerId
          ? null
          : input.plannerTicketPending?.has(project.key)
            ? "pending"
            : "issued",
        problems: [],
      };
    }),
  });
}
