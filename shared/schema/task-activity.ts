import { z } from "zod";

const toolSchema = z
  .object({
    name: z.string(),
    startedAt: z.string(),
    lastOutputAt: z.string().nullable(),
  })
  .strict();

const permissionSchema = z
  .object({
    kind: z.string(),
    since: z.string(),
  })
  .strict();

export const participantActivitySchema = z
  .object({
    runId: z.string(),
    agentId: z.string(),
    turnId: z.string().nullable(),
    turnStartedAt: z.string().nullable(),
    threadGone: z.literal(true).optional(),
    permission: permissionSchema.nullable(),
    tool: toolSchema.extend({ callId: z.string() }).nullable(),
    process: z
      .object({
        pid: z.number().int().positive(),
        startIdentity: z.string(),
        seenAt: z.number().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ParticipantActivity = z.infer<typeof participantActivitySchema>;
export type ParticipantProcess = NonNullable<ParticipantActivity["process"]>;

export const taskActivitySchema = z
  .object({
    state: z.enum([
      "active",
      "nucleus",
      "recovering",
      "needs_person",
      "finished",
      "unclassified",
    ]),
    role: z
      .enum(["worker", "reviewer", "coordinator", "closeout", "executor"])
      .nullable(),
    since: z.string(),
    /**
     * What this reading is and when it began: the fact that owns it. Stable for as long
     * as that fact holds, so a reader can tell one wait occurrence from the next without
     * reading the task's write timestamps (Spec 068 §2).
     */
    occurrence: z.string().optional(),
    detail: z.string(),
    lastActivityAt: z.string().nullable(),
    tool: toolSchema.optional(),
    permission: permissionSchema.optional(),
    attempt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type TaskActivity = z.infer<typeof taskActivitySchema>;
