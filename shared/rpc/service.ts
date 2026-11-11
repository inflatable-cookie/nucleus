import { defineRpc } from "../rpc";
import { z } from "zod";
import { hostKindSchema } from "../host-kind";
import { serviceStateSchema } from "../schema/service";

export const serviceState = defineRpc({ name: "queue.service-state", input: z.object({}).strict(), output: serviceStateSchema });

/**
 * Resolve host-supplied identity against the live host registry. This call is the
 * calling thread's own proof of life, so it is also where a registered planner
 * with no ticket yet receives one: the response carries its path and nothing is
 * sent into the thread. Issuing that ticket is the only write here, it is that
 * thread's own identity record, and it is idempotent while the assignment stands,
 * so the method stays classified as a read.
 */
export const callerResolve = defineRpc({ name: "caller.resolve", input: z.object({ hostKind: hostKindSchema, nativeAgentId: z.string().min(1) }).strict(), output: z.object({ caller: z.string().min(1), hostId: z.string().min(1), source: z.literal("host"), participantTicket: z.string().min(1).optional() }).strict() });
