import { defineRpc } from "../rpc";
import { z } from "zod";
import { projectSettingsSchema } from "../schema/project-settings";

/**
 * Without `project`, the saved list only: no host is read. With `project`, that one
 * row also carries its live planner, agent and responsible-thread state, each read
 * bounded so an offline host leaves it unknown.
 */
export const projectSettings = defineRpc({
  name: "project.settings",
  input: z.object({ project: z.string().min(1).optional() }).strict(),
  output: projectSettingsSchema,
});
