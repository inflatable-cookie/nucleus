import { defineRpc } from "../rpc";
import { z } from "zod";
import { hostKindSchema } from "../host-kind";
import { serviceStateSchema } from "../schema/service";

export const serviceState = defineRpc({ name: "queue.service-state", input: z.object({}).strict(), output: serviceStateSchema });

/** Resolve host-supplied identity against the live host registry; no state changes. */
/** The calling thread's identity, and its planner participant ticket when it is a registered planner with none yet. */
export const callerResolve = defineRpc({ name: "caller.resolve", input: z.object({ hostKind: hostKindSchema, nativeAgentId: z.string().min(1) }).strict(), output: z.object({ caller: z.string().min(1), hostId: z.string().min(1), source: z.literal("host"), participantTicket: z.string().min(1).optional() }).strict() });
