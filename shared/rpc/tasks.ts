import { defineRpc } from "../rpc";
import { z } from "zod";
import { operationAcceptanceSchema, operationBackpressuredSchema, queueOperationSchema } from "../operations";
import { submissionRecordFromLegacy } from "../schema/settings";
import { submissionSchema } from "../schema/review";
import { taskRegistrationResultSchema, taskRegistrationSchema, taskSchema } from "../schema/tasks";
import { instructionArtifactSchema } from "../hooks";

/** Legacy synchronous submission: durable acceptance plus a bounded compatibility wait. */
export const submit = defineRpc({ name: "queue.submit", input: z.preprocess(raw => submissionRecordFromLegacy(raw), submissionSchema), output: z.union([taskSchema, operationAcceptanceSchema]) });

export const completionSubscription = defineRpc({ name: "queue.completion-subscription", input: z.object({
  taskId: z.string(), version: z.number().int().positive(), agentId: z.string().min(1).max(240),
  action: z.enum(["subscribe", "unsubscribe"]),
}).strict(), output: taskSchema });

export const submitInstruction = defineRpc({name:"queue.submit-instruction",input:submissionSchema.omit({handoffPath:true,planningCommit:true,brief:true}).extend({instruction:instructionArtifactSchema}).strict(),output:z.union([taskSchema, operationAcceptanceSchema])});

export const submitHandoff = defineRpc({name:"queue.handoff",input:z.object({hostId:z.string().trim().min(1).max(240).optional(),handoffPath:z.string().min(1).optional(),briefPath:z.string().min(1).optional(),repoPath:z.string().min(1).optional(),originAgentId:z.string().min(1).max(240),coordinatorAgentId:z.string().max(240).optional(),baseBranch:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default("main"),planningCommit:z.string().regex(/^[a-f0-9]{40}$/).optional(),dryRun:z.boolean().default(false)}).strict().refine(input=>Boolean(input.handoffPath)!==Boolean(input.briefPath),"Provide exactly one of handoffPath or briefPath"),output:z.union([z.object({submission:submissionSchema,approval:z.string(),digest:z.string().optional(),task:taskSchema.nullable(),operation:queueOperationSchema.nullable().default(null)}),operationBackpressuredSchema])});

/**
 * Legacy synchronous removal. The Effigy runtime-scope capture and workspace
 * retirement run inside a durable `task_remove` operation: the historical Task
 * result is preserved only while the operation settles inside the bounded
 * compatibility window, otherwise the accepted operation is returned for
 * `queue.operation-status` observation. Repeating the same task and version
 * replays the same operation; an already-removed task returns as removed.
 */
export const removeTask = defineRpc({ name: "queue.remove", input: z.object({ taskId: z.string(), version: z.number() }).strict(), output: z.union([taskSchema, operationAcceptanceSchema]) });

export const taskRegister = defineRpc({ name: "task.register", input: taskRegistrationSchema, output: taskRegistrationResultSchema });
