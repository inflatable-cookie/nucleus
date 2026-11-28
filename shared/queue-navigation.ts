export const settingsViews = [
  { id: "capacity", label: "Dispatch limits", short: "Limits" },
  // Spec 052 / nucleus#934: one Profiles page holds the stored records and their dispatch settings;
  // nucleus#963: the Subscriptions list sits beneath them on the same page.
  { id: "profiles", label: "Profiles", short: "Profiles" },
  // Lane `nucleus-ui` (task 946): Projects replaces Repositories.
  { id: "projects", label: "Projects", short: "Projects" },
  // nucleus#1325: the host catalogue and the default host picker (nucleus#1494: after Projects).
  { id: "hosts", label: "Hosts", short: "Hosts" },
  { id: "backups", label: "Backups", short: "Backups" },
  // nucleus#1526: every work-volume path is a setting; Storage is its own page, not a Backups section.
  { id: "storage", label: "Storage", short: "Storage" },
  { id: "github-accounts", label: "GitHub", short: "GitHub" },
  { id: "devices", label: "Devices", short: "Devices" },
  { id: "telemetry", label: "Telemetry", short: "Telemetry" },
] as const;

export type SettingsSectionId = (typeof settingsViews)[number]["id"];

export type SettingsTarget = SettingsSectionId;

export function headerControls(
  paused: boolean,
  connected: boolean,
  busy: boolean,
) {
  const controls = [
    { id: "settings", icon: "Settings", label: "Settings", disabled: false },
    { id: "refresh", icon: "RefreshCw", label: "Refresh", disabled: busy },
    {
      id: "pause",
      icon: paused ? "Play" : "Pause",
      label: paused ? "Resume orchestration" : "Pause and drain",
      disabled: busy || !connected,
    },
  ] as const;
  return controls;
}

/** Whether a task is still open. A task with an origin error stays open, so it stays visible. */
export function isOpenTask(task: {
  phase: string;
  originError?: string;
  originLookupError?: string;
}): boolean {
  return (
    !["done", "cancelled"].includes(task.phase) ||
    Boolean(task.originError || task.originLookupError)
  );
}
