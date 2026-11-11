import { defineRpc } from "../rpc";
import { z } from "zod";
import { operationAcceptanceSchema } from "../operations";
import { taskControlRequestSchema, taskControlTaskSchema, taskNextInputSchema, taskNextSchema } from "../schema/task-control";

/**
 * Legacy synchronous task control. External-effect actions accept durably and
 * return the accepted operation when they do not settle inside the bounded
 * compatibility window; local transactional actions keep returning the task.
 */
export const taskControl = defineRpc({ name: "queue.task", input: taskControlRequestSchema, output: z.union([taskControlTaskSchema, operationAcceptanceSchema]) });

export const taskNext = defineRpc({ name: "task.next", input: taskNextInputSchema, output: taskNextSchema });
