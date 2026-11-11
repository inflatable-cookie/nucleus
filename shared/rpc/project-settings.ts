import { defineRpc } from "../rpc";
import { z } from "zod";
import { projectSettingsSchema } from "../schema/project-settings";

export const projectSettings = defineRpc({ name: "project.settings", input: z.object({}).strict(), output: projectSettingsSchema });
