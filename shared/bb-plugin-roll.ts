/**
 * The BB plugin step a landed service roll runs (nucleus#1339).
 *
 * Twice on 2026-11-18 a service roll left BB's installed Nucleus plugin at the
 * previous build: the pin in `shared/bb-plugin-build.ts` refused it, the BB host
 * went offline and BB tasks stalled until a planner ran `nucleus bb install` by
 * hand. A landed roll now keeps the installed plugin on the build it landed —
 * the shape of the fact it records, and the note the roll record carries, are
 * here so the bridge, the service's health and the tests read one record.
 *
 * The step never decides ownership itself: it runs `nucleus bb status`, and only
 * a plugin that BB reports as `behind` is installed through `nucleus bb install`.
 * A machine without the plugin is untouched, and a plugin that is not this
 * integration's (a namesake, or a developer's checkout install) is left alone.
 */
import { z } from "zod";

/** The owner-only record beside the roll record that this step writes. */
export const BB_PLUGIN_ROLL_FILE = "queue-bb-plugin-roll.json";

export const bbPluginRollSchema = z
  .object({
    at: z.string(),
    /** The build the landed roll replaced the service with. */
    buildId: z.string().min(8).max(64),
    /**
     * What the step did: `installed` when BB's plugin now matches this build,
     * `failed` when the install was attempted and did not land, `skipped` when
     * there was nothing to install.
     */
    action: z.enum(["installed", "failed", "skipped"]),
    /** `nucleus bb status`'s own state for the installed plugin (`behind`, `match`, …). */
    state: z.string().min(1).max(64),
    detail: z.string().max(4000),
  })
  .strict();
export type BbPluginRollRecord = z.infer<typeof bbPluginRollSchema>;

/**
 * What a landed roll's record appends for this step, and nothing for the states
 * that leave the operator's BB alone: a roll that installed the plugin says so,
 * a failed install names its cause, and an untouched plugin adds no noise.
 */
export function bbPluginRollNote(record: BbPluginRollRecord): string {
  if (record.action === "installed")
    return `; installed the BB plugin for this build (${record.state})`;
  if (record.action === "failed")
    return `; the BB plugin was not updated (${record.state}: ${record.detail})`;
  return "";
}
