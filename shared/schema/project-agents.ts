import { z } from "zod";
import { projectAgentNameSchema, projectSchema } from "./projects";

/**
 * Task 1110: a project's named agents are its non-task threads — planners,
 * leads and the coordinators of a cross-section. Registration records the
 * thread, its host and its purpose and issues a participant ticket; listing
 * reads each entry's live state from its host.
 *
 * Live state is `running`, `idle`, `archived`, `gone` or `unknown`. A host that
 * cannot be read, or a thread it cannot describe, is `unknown` — never `gone`.
 */
export const projectAgentStateSchema = z.enum(["running", "idle", "archived", "gone", "unknown"]);

export type ProjectAgentState = z.infer<typeof projectAgentStateSchema>;

export const projectAgentViewSchema = z.object({
  name: projectAgentNameSchema,
  purpose: z.string().min(1).max(400),
  agentId: z.string().min(1).max(300),
  hostId: z.string().min(1).max(240),
  state: projectAgentStateSchema,
  /** The host's last activity stamp for the thread, or null when it could not be read. */
  lastSeen: z.string().nullable(),
  /** The project's fallback planner: the thread `to: {project}` resolves to. */
  fallback: z.boolean(),
}).strict();

export type ProjectAgentView = z.infer<typeof projectAgentViewSchema>;

export const projectAgentsQuerySchema = z.object({ project: projectSchema.shape.key }).strict();

/** The name a fallback planner is registered under when `project.set-planner` gains a thread. */
export const DEFAULT_PLANNER_AGENT_NAME = "planner";

/**
 * The calling thread registers itself (the CLI resolves its ticket or host
 * identity into `caller`), or the board names one live thread in `agentId`.
 * Exactly one of the two: a thread always registers an identity it holds.
 */
export const agentRegisterInputSchema = z.object({
  project: projectSchema.shape.key,
  name: projectAgentNameSchema,
  purpose: z.string().trim().min(1).max(400),
  caller: z.string().trim().min(1).max(300).optional(),
  agentId: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict().refine(input => Boolean(input.caller) !== Boolean(input.agentId), {
  message: "agent.register names the calling thread (caller) or one chosen thread (agentId), not both",
});

export type AgentRegisterInput = z.infer<typeof agentRegisterInputSchema>;

export const agentUnregisterInputSchema = z.object({
  project: projectSchema.shape.key,
  name: projectAgentNameSchema,
  caller: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict();

export type AgentUnregisterInput = z.infer<typeof agentUnregisterInputSchema>;
