import { defineRpc } from "../rpc";
import { laneAddressSchema, laneDocumentVersionSchema, laneKeepInputSchema, laneSchema, laneStatusInputSchema, laneUpsertInputSchema, laneViewSchema, lanesQuerySchema } from "../schema/lanes";
import { z } from "zod";
import { laneDocumentEditText, briefDigestSchema } from "../schema/briefs";

export const laneUpsert = defineRpc({ name: "lane.upsert", input: laneUpsertInputSchema, output: laneSchema });

export const laneStatus = defineRpc({ name: "lane.status", input: laneStatusInputSchema, output: laneSchema });

export const laneKeep = defineRpc({ name: "lane.keep", input: laneKeepInputSchema, output: laneSchema });

export const lanes = defineRpc({ name: "lanes", input: lanesQuerySchema, output: z.array(laneViewSchema) });

export const laneDocumentGet = defineRpc({ name: "lane.document.get", input: laneAddressSchema.extend({ version: z.number().int().positive().optional() }), output: laneDocumentVersionSchema.nullable() });

/** `version` is the latest version the edit was written against; 0 for a lane without a document. */
export const laneDocumentEdit = defineRpc({ name: "lane.document.edit", input: laneAddressSchema.extend({ version: z.number().int().nonnegative(), digest: briefDigestSchema.optional(), text: laneDocumentEditText, author: z.string().min(1) }), output: laneDocumentVersionSchema });
