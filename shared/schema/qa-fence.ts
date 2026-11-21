import { z } from "zod";

export const qaFenceAuthoritySchema = z.object({
  caller: z.string().min(1).max(160),
  /** `unreadable_record`: no one set it; Queue fails closed on a stored record it cannot decode. */
  kind: z.enum(["operator", "relayed_note", "unreadable_record"]),
  note: z.string().max(4000).nullable(),
}).strict();

export const qaFenceSchema = z.object({
  id: z.string().min(1).max(80),
  until: z.string().datetime({ offset: true }),
  reason: z.string().min(1).max(1000),
  setAt: z.string().datetime({ offset: true }),
  setBy: qaFenceAuthoritySchema,
}).strict();

export type QaFence = z.infer<typeof qaFenceSchema>;

/** The stored record: every write bumps `revision`; `fence` stays stored after expiry and reads as not in force. */
export const qaFenceRecordSchema = z.object({
  revision: z.number().int().nonnegative(),
  fence: qaFenceSchema.nullable(),
  clearedAt: z.string().datetime({ offset: true }).nullable().default(null),
  clearedBy: qaFenceAuthoritySchema.nullable().default(null),
  /** The last 20 writes, newest last: what was set, replaced or cleared, by whom. */
  history: z.array(z.object({
    action: z.enum(["set", "clear"]), revision: z.number().int().positive(), at: z.string().datetime({ offset: true }),
    by: qaFenceAuthoritySchema, fence: qaFenceSchema.nullable(),
  }).strict()).max(20).default([]),
}).strict();

export type QaFenceRecord = z.infer<typeof qaFenceRecordSchema>;
