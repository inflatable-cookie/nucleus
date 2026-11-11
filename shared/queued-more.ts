/** What the board holds back from each project's queue, for its "…and N more" card and the column's real total. */
export function hiddenQueuedByProject(
  counts: ReadonlyArray<{ repoPath: string; count: number }>,
  tasks: ReadonlyArray<{ repoPath: string; phase: string }>,
): Array<{ repoPath: string; hidden: number }> {
  return counts.flatMap(item => {
    const shown = tasks.filter(task => task.phase === "queued" && task.repoPath === item.repoPath).length;
    const hidden = Math.max(0, item.count - shown);
    return hidden ? [{ repoPath: item.repoPath, hidden }] : [];
  });
}
