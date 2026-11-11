/**
 * The board's destinations (nucleus#866 folded Lanes into Planning; nucleus#1113
 * added Usage): Tasks, Planning, QA runs and the subscription usage page.
 */
export const navigationViews = [
  { id: "queue", label: "Tasks" },
  { id: "planning", label: "Planning" },
  { id: "qa", label: "QA runs" },
  { id: "usage", label: "Usage" },
] as const;

/** The workspace panel uses the same primary tabs as the main surface. */
export const workspaceNavigationViews = navigationViews;

export const settingsViews = [
  { id: "capacity", label: "Dispatch limits", short: "Limits" },
  // Spec 052 / nucleus#934: one Profiles page holds the stored records and their dispatch settings;
  // nucleus#963: the Subscriptions list sits beneath them on the same page.
  { id: "profiles", label: "Profiles", short: "Profiles" },
  // Lane `nucleus-ui` (task 946): Projects replaces Repositories.
  { id: "projects", label: "Projects", short: "Projects" },
  { id: "backups", label: "Backups", short: "Backups" },
  { id: "telemetry", label: "Telemetry", short: "Telemetry" },
] as const;

export type SettingsSectionId = (typeof settingsViews)[number]["id"];

export type SettingsTarget = SettingsSectionId;

export function headerControls(paused: boolean, connected: boolean, busy: boolean) {
  const controls = [
    { id: "settings", icon: "Settings", label: "Settings", disabled: false },
    { id: "refresh", icon: "RefreshCw", label: "Refresh", disabled: busy },
    { id: "pause", icon: paused ? "Play" : "Pause", label: paused ? "Resume orchestration" : "Pause and drain", disabled: busy || !connected },
  ] as const;
  return controls;
}

/**
 * The Tasks tab's open count. It follows the project selector, so a filtered board
 * counts only its projects' open tasks (Tom, 2026-09-28: it counted every project).
 * A task with an origin error stays counted, as before.
 */
export function openTaskCount<T extends { phase: string; repoPath: string; repository?: string | null; originError?: string; originLookupError?: string }>(
  tasks: readonly T[], belongs: (repoPath: string, origin?: string | null) => boolean,
): number {
  return tasks.filter(task => (!['done', 'cancelled'].includes(task.phase) || Boolean(task.originError || task.originLookupError))
    && belongs(task.repoPath, task.repository)).length;
}
