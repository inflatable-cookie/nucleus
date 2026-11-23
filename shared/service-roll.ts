/**
 * Automatic service roll (release contract): after the registered checkout's
 * backend source changes, the bridge typechecks it and replaces the service.
 * Shared by the bridge, the local CLI and the header notices. `rolled` means
 * the target build answered; the detail says whether a passing roll typecheck
 * preceded it.
 */
import { z } from "zod";

export const LEGACY_QA_ROLL_DEFERRED = "Legacy milestone QA upgrade deferred.";

export const serviceRollDeferralSchema = z.object({
  at: z.string(),
  reason: z.enum(["settle_window", "heavy_follower"]),
  until: z.string().nullable(),
}).strict();
export type ServiceRollDeferral = z.infer<typeof serviceRollDeferralSchema>;

export const serviceRollSchema = z.object({
  status: z.enum(["typechecking", "replacing", "retrying", "rolled", "failed", "deferred"]),
  fromBuild: z.string().max(64),
  toBuild: z.string().max(64).nullable(),
  digest: z.string().max(64),
  at: z.string(),
  detail: z.string().max(4000),
  deferrals: z.array(serviceRollDeferralSchema).max(64).default([]),
}).strict();
export type ServiceRoll = z.infer<typeof serviceRollSchema>;

/**
 * A service state the header shows as a state pill (nucleus#1540): the pill's short
 * `label`, and the full `text` in the pill's popover. The header shows no status line.
 */
export interface ServiceNotice { tone: "warning" | "quiet"; label: string; text: string }

/**
 * Header notices from the bridge's service state. The UI bundle and the bridge
 * load together, so a service build other than the plugin's loaded build means
 * the service rolled and the UI is older than it.
 */
export function serviceNotices(state: {
  state: string; detail: string; buildId: string | null; pluginBuildId?: string | null; roll?: ServiceRoll | null;
}): ServiceNotice[] {
  const notices: ServiceNotice[] = [];
  if (state.state !== "running") notices.push({ tone: "warning", label: `Service ${state.state}`, text: `Nucleus service ${state.state}${state.detail ? ` · ${state.detail}` : ""}` });
  if (state.roll?.status === "retrying") notices.push({ tone: "warning", label: "Roll retrying", text: `Nucleus is replacing its service onto the new build: ${state.roll.detail}` });
  if (state.roll?.status === "deferred") notices.push({ tone: "quiet", label: "Roll deferred", text: `Nucleus is deferring a service roll: ${state.roll.detail}` });
  if (state.roll?.status === "failed") notices.push({ tone: "warning", label: "Roll failed", text: `Nucleus kept its running service because ${state.roll.detail}` });
  if (state.state === "running" && state.buildId && state.pluginBuildId && state.buildId !== state.pluginBuildId) {
    notices.push({ tone: "quiet", label: "Reload to update", text: "Nucleus updated; reload the plugin to refresh the UI" });
  }
  return notices;
}
