import { defineRpc } from "../rpc";
import { z } from "zod";
import {
  workStorageInputSchema,
  workStorageStateSchema,
} from "../schema/work-storage";

/**
 * Settings → Storage (nucleus#1526): the resolved work-volume placement and the
 * Settings-only save that changes it. Every path is validated before it is
 * written, and a saved change applies on the next service start.
 */
export const workStorage = defineRpc({
  name: "queue.work-storage",
  input: z.object({}).strict(),
  output: workStorageStateSchema,
});

export const saveWorkStorage = defineRpc({
  name: "queue.work-storage.set",
  input: workStorageInputSchema,
  output: workStorageStateSchema,
});
