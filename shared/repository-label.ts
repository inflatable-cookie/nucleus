/**
 * One repository label for every surface (nucleus#1313, Tom 2026-11-17: "the task
 * container (nor any of the threads inside it) show what project they're working
 * on"). The board cards' rule is the repository's short name; when a short name is
 * ambiguous among the records a surface is showing, the recorded `owner/name`
 * disambiguates it. The board and the BB sidebar read this module so the label they
 * draw for one task cannot drift.
 */

/** The last path segment of a checkout: `poodle-lab` from `/synthetic/repos/poodle-lab`. */
export function repositoryShortName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPath;
}

/** The recorded `owner/name` origin, when the repository identity names one. */
function originName(repository: string | null | undefined): string | null {
  return typeof repository === "string" && repository.includes("/") ? repository : null;
}

export interface RepositoryLabelled {
  repoPath: string;
  repository?: string | null;
}

/**
 * One task's repository label: the short name, or its `owner/name` when another
 * task in `peers` shares that short name from a different origin. A caller with no
 * peer list (a single card, a single thread title) gets the short name, which is
 * the board's long-standing rule; a board-wide read ({@link repositoryLabels}) has
 * the peers and disambiguates.
 */
export function repositoryLabel(task: RepositoryLabelled, peers: readonly RepositoryLabelled[] = []): string {
  const short = repositoryShortName(task.repoPath);
  const mine = originName(task.repository);
  const clash = mine !== null && peers.some(peer => peer !== task && repositoryShortName(peer.repoPath) === short && originName(peer.repository) !== mine);
  return clash ? mine : short;
}

/** Every record's label, with the whole set as the peer context that decides ambiguity. */
export function repositoryLabels<T extends RepositoryLabelled>(tasks: readonly T[]): Map<T, string> {
  return new Map(tasks.map(task => [task, repositoryLabel(task, tasks)]));
}
