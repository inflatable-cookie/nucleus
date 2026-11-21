import React from "react";
import { Text } from "react-native";
import {
  RESERVED_LEAD_TAGS,
  type BoardLead,
  type UiQueueState,
} from "../../shared/contracts";
import {
  decisionAge,
  triageKind,
  triageStatus,
} from "../../shared/pipeline-board";
import type { ProjectBadge } from "../../shared/t3/project-badge";
import { Icon } from "../shell";
import { BoardCard, ProjectBadgeMark, statusLabel } from "./cards";
import { muted, type Colors } from "../controls";
import { type as typeScale } from "../design";

type Project = UiQueueState["projects"][number];

export interface LeadProjectEntry {
  readonly name: string;
  readonly badge: ProjectBadge | null;
}

function sameProjectBadge(
  a: ProjectBadge | null,
  b: ProjectBadge | null,
): boolean {
  return Boolean(a && b && a.monogram === b.monogram && a.color === b.color);
}

/**
 * Resolve each unique project name on a lead or papercut card and its unambiguous T3 badge.
 * Grouping by project name preserves the existing display names and order; a project group
 * shows a badge only when every repository in that group agrees on one T3 badge, avoiding any
 * choice by repository order (nucleus#1490).
 */
export function leadProjectEntries(
  repositories: BoardLead["repositories"],
  projectForRepository: (
    repoPath: string,
    origin?: string | null,
  ) => Pick<Project, "name"> | undefined,
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>,
): LeadProjectEntry[] {
  const groups = new Map<string, BoardLead["repositories"]>();
  for (const repo of repositories) {
    // The project's name, not its repository's: a project can be named differently from its repository (Tom, 2026-11-07).
    const name =
      projectForRepository(repo.path, repo.origin)?.name ??
      repo.origin.split("/").at(-1) ??
      repo.origin;
    const list = groups.get(name) ?? [];
    list.push(repo);
    groups.set(name, list);
  }
  const out: LeadProjectEntry[] = [];
  for (const [name, repos] of groups) {
    const badges = repos.map((repo) => repositoryBadges?.[repo.path] ?? null);
    const first = badges[0] ?? null;
    const badge =
      first && badges.every((candidate) => sameProjectBadge(candidate, first))
        ? first
        : null;
    out.push({ name, badge });
  }
  return out;
}

/** Project eyebrow for lead and papercut cards, sharing `ProjectBadgeMark` with `TaskCard`. */
export function LeadProjectEyebrow({
  repositories,
  projectForRepository,
  repositoryBadges,
  c,
}: {
  repositories: BoardLead["repositories"];
  projectForRepository: (
    repoPath: string,
    origin?: string | null,
  ) => Pick<Project, "name"> | undefined;
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>;
  c: Colors;
}) {
  const entries = leadProjectEntries(
    repositories,
    projectForRepository,
    repositoryBadges,
  );
  const labelStyle = {
    ...muted(c),
    fontSize: typeScale.metadata.fontSize,
    flexShrink: 1,
  } as const;
  if (entries.every((entry) => entry.badge === null)) {
    return (
      <>
        <Icon name="Folder" size={12} color={c.foregroundMuted} />
        <Text numberOfLines={1} ellipsizeMode="tail" style={labelStyle}>
          {entries.map((entry) => entry.name).join(", ")}
        </Text>
      </>
    );
  }
  return (
    <>
      {entries.map((entry, index) => (
        <React.Fragment key={entry.name}>
          {entry.badge ? (
            <ProjectBadgeMark badge={entry.badge} c={c} />
          ) : (
            <Icon name="Folder" size={12} color={c.foregroundMuted} />
          )}
          <Text numberOfLines={1} ellipsizeMode="tail" style={labelStyle}>
            {index < entries.length - 1 ? `${entry.name},` : entry.name}
          </Text>
        </React.Fragment>
      ))}
    </>
  );
}

/** Owns the shared Lead/Papercut row and its single tag classification. */
export function TriageLeadCard({
  lead,
  projectForRepository,
  repositoryBadges,
  selected,
  c,
  onSelectLead,
  onSelectPapercut,
}: {
  lead: BoardLead;
  projectForRepository?: (
    repoPath: string,
    origin?: string | null,
  ) => Pick<Project, "name"> | undefined;
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>;
  selected: boolean;
  c: Colors;
  onSelectLead: (id: string) => void;
  onSelectPapercut: (id: string) => void;
}) {
  const kind = triageKind(lead);
  const status = triageStatus(lead);
  const kindWord = kind === "papercut" ? RESERVED_LEAD_TAGS.papercut : "Lead";
  return (
    <BoardCard
      label={`${kindWord}: ${lead.title}, ${statusLabel(status)}`}
      c={c}
      kind={kind}
      meta={kindWord}
      project={
        <LeadProjectEyebrow
          repositories={lead.repositories}
          projectForRepository={projectForRepository ?? (() => undefined)}
          repositoryBadges={repositoryBadges}
          c={c}
        />
      }
      age={lead.createdAt ? decisionAge(lead.createdAt) : null}
      title={lead.title}
      status={status}
      selected={selected}
      onPress={() =>
        kind === "papercut" ? onSelectPapercut(lead.id) : onSelectLead(lead.id)
      }
    />
  );
}
