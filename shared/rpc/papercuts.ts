import { defineRpc } from "../rpc";
import { papercutAddInputSchema, papercutSchema, papercutStateSchema } from "../schema/papercuts";
import { z } from "zod";
import { laneKeyListSchema } from "../schema/task-primitives";

export const papercutAdd = defineRpc({ name: "papercut.add", input: papercutAddInputSchema, output: papercutSchema });

export const papercutList = defineRpc({ name: "papercut.list", input: z.object({ repository: z.string().optional(), state: papercutStateSchema.default("open") }).strict(), output: z.array(papercutSchema) });

export const papercutGet = defineRpc({ name: "papercut.get", input: z.object({ id: z.string().min(1) }).strict(), output: papercutSchema });

export const papercutEdit = defineRpc({ name: "papercut.edit", input: z.object({
  id: z.string().min(1), version: z.number().int().positive(),
  title: z.string().trim().min(1).optional(),
  area: z.string().trim().optional(), happened: z.string().trim().min(1).optional(),
  impact: z.string().trim().optional(), fix: z.string().trim().optional(), author: z.string().min(1).default("operator"),
}).strict(), output: papercutSchema });

export const papercutPromote = defineRpc({ name: "papercut.promote", input: z.object({ id: z.string().min(1), taskId: z.string().optional(), reference: z.string().optional() }).strict().refine(input => Boolean(input.taskId) !== Boolean(input.reference), "Provide one task identity"), output: papercutSchema });

export const papercutClose = defineRpc({ name: "papercut.close", input: z.object({ id: z.string().min(1), reason: z.enum(["completed", "deprecated"]), note: z.string().default("") }).strict(), output: papercutSchema });

export const papercutSetLanes = defineRpc({ name: "papercut.set-lanes", input: z.object({ id: z.string().min(1), lanes: laneKeyListSchema }).strict(), output: papercutSchema });
