import { z } from "zod";
import { defineRpc } from "../shared/rpc";

/**
 * Board contracts only the Rust engine answers (Spec 070 rulings 8 and 17).
 * They stay out of the service RPC catalogue; the shared screens show their
 * controls only when `useEngineFeatures().engine` is `rust`.
 */

const allowance = z.object({ minutes: z.number().int().positive().nullable() }).strict();

/** Ruling 17: budgets become one allowance, in minutes; null is no limit. */
export const rustAllowance = defineRpc({
  name: "rust.dispatch.allowance",
  input: z.object({}).strict(),
  output: allowance,
});

export const rustSetAllowance = defineRpc({
  name: "rust.dispatch.allowance.set",
  input: allowance,
  output: allowance,
});

/** Ruling 8: an archived project takes no new work. */
export const rustProjectArchive = defineRpc({
  name: "rust.project.archive",
  input: z.object({ project: z.string().min(1), archived: z.boolean() }).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
});
