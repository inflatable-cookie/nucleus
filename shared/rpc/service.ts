import { defineRpc } from "../rpc";
import { z } from "zod";
import { hostKindSchema } from "../host-kind";
import { serviceStateSchema } from "../schema/service";
import { verbTargetSchema, TASK_ROLES, VERB_TEXT_MAX_CHARS } from "../agent-verbs.mjs";

export const serviceState = defineRpc({ name: "queue.service-state", input: z.object({}).strict(), output: serviceStateSchema });

/**
 * Resolve host-supplied identity against the live host registry. This call is the
 * calling thread's own proof of life, so it is also where a registered planner
 * with no ticket yet receives one: the response carries its path and nothing is
 * sent into the thread. Issuing that ticket is the only write here, it is that
 * thread's own identity record, and it is idempotent while the assignment stands,
 * so the method stays classified as a read.
 */
export const callerResolve = defineRpc({ name: "caller.resolve", input: z.object({ hostKind: hostKindSchema, nativeAgentId: z.string().min(1), hostScope: z.string().trim().min(1).max(500).optional() }).strict(), output: z.object({ caller: z.string().min(1), hostId: z.string().min(1), source: z.literal("host"), runTicket: z.string().min(1).optional(), participantTicket: z.string().min(1).optional() }).strict() });

const agentTellReceipt = z.union([
  z.object({ status: z.literal("delivered"), messageId: z.string(), to: z.string(), role: z.string(), recordedAt: z.string(), deliveredAt: z.string() }).strict(),
  z.object({ status: z.literal("queued"), messageId: z.string(), to: z.string(), role: z.string(), recordedAt: z.string(), detail: z.string() }).strict(),
  z.object({ status: z.literal("uncertain"), messageId: z.string(), to: z.string(), role: z.string(), recordedAt: z.string(), detail: z.string() }).strict(),
  z.object({ status: z.literal("expired"), messageId: z.string(), to: z.string(), role: z.string(), recordedAt: z.string(), detail: z.string() }).strict(),
  z.object({ status: z.literal("duplicate"), messageId: z.string(), detail: z.string() }).strict(),
]);

/**
 * Tell from a host-verified thread that has no run or participant ticket.
 * The service re-proves the caller; the payload names a recipient, never a thread ID.
 */
export const agentTell = defineRpc({
  name: "agent.tell",
  input: z.object({
    hostKind: hostKindSchema,
    nativeAgentId: z.string().min(1),
    hostScope: z.string().trim().min(1).max(500).optional(),
    eventId: z.string().regex(/^[a-f0-9]{64}$/),
    to: verbTargetSchema,
    role: z.enum(TASK_ROLES).optional(),
    text: z.string().trim().min(1).max(VERB_TEXT_MAX_CHARS),
  }).strict(),
  output: agentTellReceipt,
});
