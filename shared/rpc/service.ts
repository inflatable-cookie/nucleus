import { defineRpc } from "../rpc";
import { z } from "zod";
import { serviceStateSchema } from "../schema/service";

export const serviceState = defineRpc({ name: "queue.service-state", input: z.object({}).strict(), output: serviceStateSchema });
