import { z } from "zod";

/**
 * Spec 058 rollout step 3 (task 621): one worker-to-worker message, recorded once
 * and shown to both tasks. `status` follows delivery: `queued` waits for the
 * recipient role's next turn, `delivered` reached its thread, `expired` names a
 * recipient that finished before delivery. A message carries information only;
 * nothing in it changes any task state, and no authority ever rides on one.
 */
export const agentMessageRecordSchema = z.object({
  id: z.string(),
  /** Content identity for the duplicate rule: sender, recipient, role and text digest. */
  contentKey: z.string(),
  fromTaskId: z.string(), fromRole: z.enum(["worker", "reviewer"]),
  fromAgentId: z.string().nullable().default(null), fromReference: z.string().nullable().default(null), fromProject: z.string().nullable().default(null),
  fromHostId: z.string().min(1).nullable().optional(),
  toTaskId: z.string(), toRole: z.enum(["worker", "reviewer"]),
  toAgentId: z.string().nullable().default(null), toReference: z.string().nullable().default(null),
  toHostId: z.string().min(1).nullable().optional(),
  textDigest: z.string(),
  /** The message body itself, bounded to the send limit; both tasks' detail shows it. */
  text: z.string().min(1),
  status: z.enum(["queued", "uncertain", "delivered", "expired"]),
  /** Durable host-bound send fence; if still present after interruption, delivery is unknown. */
  deliveryIntentAt: z.string().optional(), deliveryHostId: z.string().min(1).optional(),
  deliveryIntentState: z.enum(['intent', 'refused']).optional(),
  createdAt: z.string(), deliveredAt: z.string().nullable().default(null),
  /** Last delivery wait or failure reason while the message sits queued. */
  error: z.string().default(""),
});

export type AgentMessageRecord = z.infer<typeof agentMessageRecordSchema>;
