import { defineRpc } from "../rpc";
import { z } from "zod";
import { operationAcceptanceSchema, operationKindSchema, queueOperationSchema } from "../operations";
import { operationPayloadSchema } from "../schema/operations";

export const operationStart = defineRpc({
  name: "queue.operation-start",
  input: z.object({
    key: z.string().min(1).max(200),
    kind: operationKindSchema,
    payload: operationPayloadSchema,
    taskId: z.string().min(1).max(160).optional(),
    expectedVersion: z.number().int().positive().optional(),
    repoPath: z.string().min(1).max(1024).optional(),
    submissionId: z.string().min(1).max(160).optional(),
    hostId: z.string().trim().min(1).max(240).optional(),
  }).strict(),
  output: operationAcceptanceSchema,
});

export const operationStatus = defineRpc({
  name: "queue.operation-status",
  input: z.object({ operationId: z.string().min(1).max(64), reconcilePreSendInputHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  output: queueOperationSchema,
});
