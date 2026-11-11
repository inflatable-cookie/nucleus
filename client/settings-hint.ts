import { useEffect, useState } from "react";
import { type SettingsSectionId, type SettingsTarget } from "../shared/queue-navigation";

/*
 * The section hint for `openSettings` (lane `nucleus-ui`, "Projects in Settings",
 * build task 4). A host's settings route takes only the screen id, so the caller
 * leaves the section here first and the Settings screen takes it: on mount, or at
 * once when it is already showing. A hint is used once; plain Settings opens at
 * its first section.
 */
let pending: SettingsTarget | null = null;
const listeners = new Set<(target: SettingsTarget) => void>();

export function hintSettingsSection(target: SettingsTarget): void {
  pending = target;
  for (const listener of listeners) listener(target);
}

/** The waiting hint, cleared as it is read. */
export function takeSettingsSection(): SettingsTarget | null {
  const target = pending;
  pending = null;
  return target;
}

/** The Settings screen's section: a waiting hint, else `initial`; a later hint moves it. */
export function useSettingsSection(initial: SettingsSectionId): [SettingsSectionId, (target: SettingsTarget) => void] {
  const [at, setAt] = useState<SettingsSectionId>(() => takeSettingsSection() ?? initial);
  useEffect(() => {
    const listener = (next: SettingsTarget) => { pending = null; setAt(next); };
    listeners.add(listener);
    const late = takeSettingsSection();
    if (late) setAt(late);
    return () => { listeners.delete(listener); };
  }, []);
  return [at, setAt];
}
