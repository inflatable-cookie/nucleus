import { z } from "zod";
import { defineRpc } from "../shared/rpc";

/**
 * Board contracts only the Rust engine answers (Spec 070 ruling 8).
 * They stay out of the service RPC catalogue; the shared screens show their
 * controls only when `useEngineFeatures().engine` is `rust`.
 */

/** Ruling 8: an archived project takes no new work. */
export const rustProjectArchive = defineRpc({
  name: "rust.project.archive",
  input: z.object({ project: z.string().min(1), archived: z.boolean() }).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
});
