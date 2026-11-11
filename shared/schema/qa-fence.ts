import { z } from "zod";

/**
 * QA admission fence (papercut 26636095; Tom, 2026-10-22: "Build as designed",
 * "Operator + relay", "10 min default, 2 h cap"). A host-wide, expiring fence on
 * NEW project QA admissions while an install owner swaps a shared tool. It
 * never touches admitted, queued or running QA, task validation or Effigy
 * client host runs.
 */
export const QA_FENCE_DEFAULT_MINUTES = 10;

export const QA_FENCE_MAX_MINUTES = 120;

/** Every refusal the fence writes starts with this; the scheduler reads it as a lifecycle refusal. */
export const QA_FENCE_REFUSAL_PREFIX = "QA admission is fenced";

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

/** What the board shows: the fence in force (null once cleared or expired) and the stored record behind it. */
export const qaFenceViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  fence: qaFenceSchema.nullable(),
  expired: qaFenceSchema.nullable(),
}).strict();

export type QaFenceView = z.infer<typeof qaFenceViewSchema>;

/** One unsettled QA custody item; the inventory is complete across all rows, never a recent-history index. */
export const qaInventoryItemSchema = z.object({
  kind: z.enum(["qa_run", "qa_request", "host_run"]),
  id: z.string(),
  repository: z.string(),
  state: z.string(),
  detail: z.string(),
}).strict();

export type QaInventoryItem = z.infer<typeof qaInventoryItemSchema>;

export const qaFenceStatusSchema = z.object({
  view: qaFenceViewSchema,
  inventory: z.array(qaInventoryItemSchema),
  readAt: z.string(),
}).strict();

export type QaFenceStatus = z.infer<typeof qaFenceStatusSchema>;
