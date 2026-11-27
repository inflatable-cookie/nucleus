import { defineRpc } from "../rpc";
import { eventSchema, missingResultSchema, snapshotInputSchema, snapshotStateSchema, uiBoardSchema } from "../schema/state";
import { z } from "zod";
import { taskSummarySchema } from "../schema/task-view";
import { laneKeySchema } from "../schema/task-primitives";
import { hookRecordSchema } from "../hooks";
import { queueOperationSchema } from "../operations";
import { taskTelemetrySchema } from "../telemetry";
import { taskDetailSchema, taskReferenceSchema } from "../schema/tasks";
import { noticeSchema, runSchema } from "../schema/runs";
import { agentMessageRecordSchema } from "../schema/messages";
import { routingPolicySchema } from "../schema/settings";

export const snapshot = defineRpc({ name: "queue.snapshot", input: snapshotInputSchema, output: snapshotStateSchema });

export const queuePage = defineRpc({ name: "queue.queued-page", input: z.object({ repoPath: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(25) }).strict(), output: z.object({ tasks: z.array(taskSummarySchema), nextOffset: z.number().int().nonnegative().nullable() }) });

export const laneTaskPage = defineRpc({ name: "lane.task-page", input: z.object({ lane: laneKeySchema, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(25) }).strict(), output: z.object({ tasks: z.array(taskSummarySchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() }) });

export const uiSnapshot = defineRpc({ name: "queue.ui-snapshot", input: z.object({ revision: z.number().int().nonnegative().optional() }).strict(), output: uiBoardSchema });

