import { z } from "zod";
import { defineRpc } from "../rpc";
import { projectSchema } from "../schema/projects";
import {
  agentRegisterInputSchema,
  agentUnregisterInputSchema,
  projectAgentViewSchema,
  projectAgentsQuerySchema,
} from "../schema/project-agents";

/** Task 1110: a project's named, non-task threads. */
export const projectAgents = defineRpc({ name: "project.agents", input: projectAgentsQuerySchema, output: z.array(projectAgentViewSchema) });

export const agentRegister = defineRpc({ name: "agent.register", input: agentRegisterInputSchema, output: projectSchema });

export const agentUnregister = defineRpc({ name: "agent.unregister", input: agentUnregisterInputSchema, output: projectSchema });
