import { z } from "zod";
import { defineRpc } from "../rpc";

/**
 * Spec 065: binding a task to one ACP session.
 *
 * The caller names a task; Nucleus mints the session and writes the owner-only
 * pointer into the task's checkout, then answers with where it is. The token stays
 * in that file: nothing here returns it, so a CLI call or a log cannot leak a
 * credential. A host adapter that opens a task's ACP thread calls this first; an
 * operator uses it to register the agent in an ACP-capable app by hand.
 */
export const acpBind = defineRpc({
  name: "acp.bind",
  input: z.object({ taskId: z.string().trim().min(1).max(160) }).strict(),
  output: z.object({
    sessionId: z.string().uuid(),
    taskId: z.string().min(1),
    /** Where the agent finds its binding, relative to nothing: an absolute path. */
    bindingPath: z.string().min(1),
  }).strict(),
});
