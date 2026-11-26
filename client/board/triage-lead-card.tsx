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
import { generatedProjectBadge, type ProjectBadge } from "../../shared/t3/project-badge";
import { Icon } from "../shell";
import { BoardCard, ProjectBadgeMark, statusLabel } from "./cards";
import { type Colors } from "../controls";
import { cardLabelColor, type as typeScale } from "../design";

type Project = UiQueueState["projects"][number];

interface LeadProjectEntry {
  readonly id: string;
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
 * A group keeps a T3 refinement when its repositories agree. A known Rust
 * project can always draw its own generated badge, regardless of repo order.
 */
export function leadProjectEntries(
  repositories: BoardLead["repositories"],
  projectForRepository: (
    repoPath: string,
    origin?: string | null,
  ) => (Pick<Project, "name"> & Partial<Pick<Project, "key">>) | undefined,
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>,
): LeadProjectEntry[] {
  const groups = new Map<string, { name: string; key?: string; repos: BoardLead["repositories"] }>();
  for (const repo of repositories) {
    // The project's name, not its repository's: a project can be named differently from its repository (Tom, 2026-11-07).
    const project = projectForRepository(repo.path, repo.origin);
    const name = project?.name || project?.key || (repo.origin.split("/").at(-1) ?? repo.origin);
    const key = project?.key;
    const groupId = key ? `project:${key}` : `name:${name}`;
    const group = groups.get(groupId) ?? { name, key, repos: [] };
    group.repos.push(repo);
    groups.set(groupId, group);
  }
  const out: LeadProjectEntry[] = [];
  for (const [id, { name, key, repos }] of groups) {
    const badges = repos.map((repo) => repositoryBadges?.[repo.path] ?? null);
    const first = badges[0] ?? null;
    const badge =
      first && badges.every((candidate) => sameProjectBadge(candidate, first))
        ? first
        : key ? generatedProjectBadge(name.trim() || key) : null;
    out.push({ id, name, badge });
  }
  return out;
}

/** Project marks drawn on a row's line 1 before the rest collapse to "+N". */
const MAX_PROJECT_MARKS = 2;

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
  ) => (Pick<Project, "name"> & Partial<Pick<Project, "key">>) | undefined;
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>;
  c: Colors;
}) {
  const entries = leadProjectEntries(
    repositories,
    projectForRepository,
    repositoryBadges,
  );
  const labelStyle = {
    color: cardLabelColor(c),
    fontSize: typeScale.metadata.fontSize,
    flexShrink: 1,
  } as const;
  if (entries.every((entry) => entry.badge === null)) {
    return (
      <>
        <Icon name="Folder" size={12} color={labelStyle.color} />
        <Text numberOfLines={1} ellipsizeMode="tail" style={labelStyle}>
          {entries.map((entry) => entry.name).join(", ")}
        </Text>
      </>
    );
  }
  // Line 1 has room for two project marks; the rest read as one "+N" count, so the
  // group stays inside the meta line and the age keeps its place (nucleus#1515).
  const shown = entries.slice(0, MAX_PROJECT_MARKS);
  const more = entries.length - shown.length;
  return (
    <>
      {shown.map((entry, index) => (
        <React.Fragment key={entry.id}>
          {entry.badge ? (
            <ProjectBadgeMark badge={entry.badge} c={c} />
          ) : (
            <Icon name="Folder" size={12} color={labelStyle.color} />
          )}
          <Text numberOfLines={1} ellipsizeMode="tail" style={labelStyle}>
            {index < shown.length - 1 ? `${entry.name},` : entry.name}
          </Text>
        </React.Fragment>
      ))}
      {more > 0 && (
        <Text
          numberOfLines={1}
          accessibilityLabel={`and ${more} more project${more === 1 ? "" : "s"}`}
          style={{ ...labelStyle, flexShrink: 0 }}
        >
          {`+${more}`}
        </Text>
      )}
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
  showKindWord = true,
}: {
  lead: BoardLead;
  projectForRepository?: (
    repoPath: string,
    origin?: string | null,
  ) => (Pick<Project, "name"> & Partial<Pick<Project, "key">>) | undefined;
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>;
  selected: boolean;
  c: Colors;
  onSelectLead: (id: string) => void;
  onSelectPapercut: (id: string) => void;
  /**
   * Single-kind lists (Leads, Papercuts) drop the kind word, so line 1 starts
   * with the project; lists that mix kinds keep it. Task references stay either way.
   */
  showKindWord?: boolean;
}) {
  const kind = triageKind(lead);
  const status = triageStatus(lead);
  const ageAt = lead.updatedAt || lead.createdAt;
  const kindWord = kind === "papercut" ? RESERVED_LEAD_TAGS.papercut : "Lead";
  return (
    <BoardCard
      label={`${kindWord}: ${lead.title}, ${statusLabel(status)}`}
      c={c}
      kind={kind}
      meta={showKindWord ? kindWord : null}
      project={
        <LeadProjectEyebrow
          repositories={lead.repositories}
          projectForRepository={projectForRepository ?? (() => undefined)}
          repositoryBadges={repositoryBadges}
          c={c}
        />
      }
      age={ageAt ? decisionAge(ageAt) : null}
      title={lead.title}
      status={status}
      selected={selected}
      parked={Boolean(lead.parked)}
      onPress={() =>
        kind === "papercut" ? onSelectPapercut(lead.id) : onSelectLead(lead.id)
      }
    />
  );
}
