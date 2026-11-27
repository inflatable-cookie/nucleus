import { z } from "zod";
import { defineRpc } from "../shared/rpc";
import { uiStateSchema } from "../shared/schema/state";

/**
 * Board contracts only the Rust engine answers (Spec 070 ruling 8).
 * They stay out of the service RPC catalogue; the board runs only on the Rust
 * engine, so its screens show these controls directly.
 */

/** Ruling 8: an archived project takes no new work. */
export const rustProjectArchive = defineRpc({
  name: "rust.project.archive",
  input: z.object({ project: z.string().min(1), archived: z.boolean() }).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
});


export const rustProfileUsage = defineRpc({
  name: "rust.profile-usage",
  input: z.object({}).strict(),
  output: uiStateSchema.pick({
    availability: true,
    assignments: true,
    recentAssignments: true,
    recentAssignmentSample: true,
    recentAssignmentRoles: true,
  }),
});
export const RUST_PROFILE_USAGE_KEY = ["nucleus", "rust-profile-usage"] as const;
