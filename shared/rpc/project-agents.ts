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

/**
 * Task 1110: a thread that registered itself receives its participant ticket in
 * this response, exactly as a self-naming planner does; nothing is messaged into
 * the thread.
 */
export const agentRegister = defineRpc({ name: "agent.register", input: agentRegisterInputSchema, output: projectSchema.extend({ participantTicket: z.string().min(1).optional() }) });

export const agentUnregister = defineRpc({ name: "agent.unregister", input: agentUnregisterInputSchema, output: projectSchema });
