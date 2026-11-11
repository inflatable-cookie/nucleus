import { defineRpc } from "../rpc";
import { laneDocumentVersionSchema, laneKeepInputSchema, laneSchema, laneStatusInputSchema, laneUpsertInputSchema, laneViewSchema, lanesQuerySchema } from "../schema/lanes";
import { z } from "zod";
import { laneKeySchema } from "../schema/task-primitives";
import { LANE_DOCUMENT_MAX, briefDigestSchema } from "../schema/briefs";

export const laneUpsert = defineRpc({ name: "lane.upsert", input: laneUpsertInputSchema, output: laneSchema });

export const laneStatus = defineRpc({ name: "lane.status", input: laneStatusInputSchema, output: laneSchema });

export const laneKeep = defineRpc({ name: "lane.keep", input: laneKeepInputSchema, output: laneSchema });

export const lanes = defineRpc({ name: "lanes", input: lanesQuerySchema, output: z.array(laneViewSchema) });

export const laneDocumentGet = defineRpc({ name: "lane.document.get", input: z.object({ key: laneKeySchema, version: z.number().int().positive().optional() }).strict(), output: laneDocumentVersionSchema.nullable() });

/** `version` is the latest version the edit was written against; 0 for a lane without a document. */
export const laneDocumentEdit = defineRpc({ name: "lane.document.edit", input: z.object({ key: laneKeySchema, version: z.number().int().nonnegative(), digest: briefDigestSchema.optional(), text: z.string().max(LANE_DOCUMENT_MAX), author: z.string().min(1) }).strict(), output: laneDocumentVersionSchema });
