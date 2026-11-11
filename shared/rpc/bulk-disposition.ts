import { defineRpc } from "../rpc";
import { bulkDispositionRequestSchema, bulkDispositionSchema } from "../schema/bulk-disposition";
import { z } from "zod";

export const bulkDisposition = defineRpc({ name: "queue.bulk-disposition", input: bulkDispositionRequestSchema, output: bulkDispositionSchema });

export const bulkDispositionDetail = defineRpc({ name: "queue.bulk-disposition-detail", input: z.object({ operationId: z.string().min(1).max(160) }).strict(), output: bulkDispositionSchema });

export const retryBulkDisposition = defineRpc({ name: "queue.bulk-disposition-retry", input: z.object({ operationId: z.string().min(1).max(160) }).strict(), output: bulkDispositionSchema });
