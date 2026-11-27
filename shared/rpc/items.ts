import { z } from "zod";
import { defineRpc } from "../rpc";
import { capabilityLevelSchema } from "../schema/settings/capability";

/**
 * The Rust engine's planning item (Spec 070: one record, a kind) as the lead and
 * papercut view reads it (Spec 071, "Leads and papercuts"). The engine's own state,
 * disposition and history are kept as they are, so the view never infers them.
 */
const itemDisposition = z.enum(["completed", "deprecated"]);

export const itemHistoryEntrySchema = z.object({
  actor: z.string(),
  atMs: z.number().int(),
  action: z.string(),
  /** The reopen note, when the reopen carried one. */
  note: z.string().nullable(),
  /** A drop's disposition, read from the recorded snapshot. */
  disposition: itemDisposition.nullable(),
  /** An assessment send's recipient thread or "new planner thread". */
  recipient: z.string().nullable().default(null),
});

export const itemDetailSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["lead", "papercut"]),
  projectKey: z.string().min(1),
  projectName: z.string(),
  title: z.string(),
  body: z.string(),
  lanes: z.array(z.string()),
  /** The item's repositories, each with whether it is bound to a T3 project. */
  repositories: z.array(z.object({ origin: z.string(), bound: z.boolean() })),
  author: z.string(),
  authorLabel: z.string().optional(),
  state: z.enum(["open", "parked", "promoted", "dropped"]),
  reason: z.string().nullable(),
  disposition: itemDisposition.nullable(),
  /** A lead's brief complexity as the engine parses it; null for papercuts and undeclared briefs. */
  briefComplexity: capabilityLevelSchema.nullable(),
  revisitAt: z.string().nullable(),
  taskId: z.string().nullable(),
  version: z.number().int().positive(),
  createdAtMs: z.number().int().nullable(),
  updatedAtMs: z.number().int().nullable(),
  history: z.array(itemHistoryEntrySchema),
});

export type ItemDetail = z.infer<typeof itemDetailSchema>;
export type ItemHistoryEntry = z.infer<typeof itemHistoryEntrySchema>;

const address = { id: z.string().min(1), project: z.string().min(1) };

export const itemGet = defineRpc({
  name: "item.get",
  input: z.object({ id: z.string().min(1), project: z.string().min(1).optional() }).strict(),
  output: itemDetailSchema,
});

/** Saves at the version the editor opened, so a concurrent change is refused. */
export const itemEdit = defineRpc({
  name: "item.edit",
  input: z
    .object({
      ...address,
      version: z.number().int().positive(),
      title: z.string().trim().min(1),
      body: z.string().refine((text) => text.trim().length > 0, "A body is required."),
    })
    .strict(),
  output: itemDetailSchema,
});

/** Parks an open item, or parks a parked one again with a new date. */
export const itemPark = defineRpc({
  name: "item.park",
  input: z
    .object({
      ...address,
      reason: z.string().trim().min(1).max(4000),
      revisitAt: z.string().nullable(),
    })
    .strict(),
  output: itemDetailSchema,
});

export const itemDrop = defineRpc({
  name: "item.drop",
  input: z
    .object({
      ...address,
      disposition: itemDisposition,
      note: z.string().trim().max(4000),
    })
    .strict(),
  output: itemDetailSchema,
});

export const itemReopen = defineRpc({
  name: "item.reopen",
  input: z.object({ ...address, version: z.number().int().positive() }).strict(),
  output: itemDetailSchema,
});

export const itemAssess = defineRpc({
  name: "item.assess",
  input: z.object({ ...address, version: z.number().int().positive() }).strict(),
  output: itemDetailSchema,
});

/** A promoted or dropped item, for the Leads and Papercuts lists' Closed filter. */
export const closedItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["lead", "papercut"]),
  projectKey: z.string().min(1),
  projectName: z.string(),
  title: z.string(),
  state: z.enum(["promoted", "dropped"]),
  disposition: itemDisposition.nullable(),
  /** When the item last changed, which for a closed item is when it closed. */
  atMs: z.number().int().nullable(),
});

export type ClosedItem = z.infer<typeof closedItemSchema>;

export const itemClosed = defineRpc({
  name: "item.closed",
  input: z.object({ kind: z.enum(["lead", "papercut"]) }).strict(),
  output: z.array(closedItemSchema),
});
