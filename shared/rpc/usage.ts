import { defineRpc } from "../rpc";
import { z } from "zod";
import { usageStateOutputSchema } from "../schema/usage";

/** The subscriptions' usage readings, projections and freshness (Spec 059). Read-only. */
export const usageState = defineRpc({
  name: "usage.state",
  input: z.object({}).strict(),
  output: usageStateOutputSchema,
});
