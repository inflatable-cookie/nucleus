/** Spec 019 lane helpers. Pure matching and attachment rules; lane discovery is Planning's search (shared/lane-finder.ts). */
export const LANE_AIM_MAX = 2000;
export const LANE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Normalise a git remote or `owner/name` to Queue's origin slug. */
export function normalizeRepositoryOrigin(value: string): string | null {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const hosted = trimmed.match(/(?:github\.com[:/]|gitlab\.com[:/]|bitbucket\.org[:/])([^/]+\/[^/#?]+)$/i);
  const slug = hosted ? hosted[1] : trimmed;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) return null;
  return slug.toLowerCase();
}

export function laneListsRepository(
  repositories: Array<{ origin: string; path: string }>,
  repoPath: string,
  origin?: string | null,
): boolean {
  return repositories.some(repo => repo.path === repoPath || Boolean(origin && repo.origin === origin));
}

export type LaneBoardTask = { lanes: string[]; repoPath: string; repository?: string | null };
export type LaneBoardLane = {
  key: string;
  title: string;
  aim: string;
  status: "active" | "paused" | "done" | "abandoned";
  note?: string;
  repositories: Array<{ origin: string; path: string }>;
  lastActivityAt: string | null;
};
