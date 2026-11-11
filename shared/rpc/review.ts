import { z } from "zod";
import { reviewEntryWorkspaceInputSchema } from "../schema/review";
import { defineRpc } from "../rpc";
import { reviewEntryInputSchema, reviewEntryPreviewResultSchema, reviewEntryReconcileInputSchema } from "../schema/review";
import { queueOperationSchema } from "../operations";

export const reviewEntryPreview=defineRpc({name:"queue.review-entry-preview",input:reviewEntryInputSchema,output:reviewEntryPreviewResultSchema});

export const reviewEntryReconcile=defineRpc({name:"queue.review-entry-reconcile",input:reviewEntryReconcileInputSchema,output:queueOperationSchema});

export const reviewEntryWorkspace=defineRpc({name:"queue.review-entry-workspace",input:reviewEntryWorkspaceInputSchema,output:z.object({workspaceId:z.string().min(1)}).strict()});
