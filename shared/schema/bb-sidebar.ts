import { z } from "zod";

/**
 * Spec 062 decision 5b: the one bounded read the forked sidebar draws a Nucleus
 * task group from.
 *
 * It is a projection of two records the service already owns — the live task rows
 * and the BB workspace handles — joined by the task's recorded workspace. It reads
 * no forge, no Git and no thread timeline: the PR facts are the board's own
 * `prStates` record and the card's numbers, and the labels are the strings
 * `shared/task-state.ts` and `shared/wait-state.ts` already name for the Paseo
 * board, so the two hosts cannot name a state differently.
 *
 * Absent facts are nullable rather than invented: a task with no PR carries no PR
 * number, and a task in no declared wait carries no wait label. The sidebar renders
 * exactly what is present.
 */
export const bbSidebarGroupSchema = z.object({
  /** The BB environment the group belongs to: the join key every sidebar row carries. */
  environmentId: z.string().min(1).max(240),
  taskId: z.string().min(1).max(240),
  number: z.number().int().positive().nullable(),
  reference: z.string().nullable(),
  title: z.string().min(1),
  phase: z.string().min(1).max(60),
  /** The phase alone, without the hold or wait that may stand on it. */
  phaseLabel: z.string().min(1).max(240),
  /** The phase with a blocking hold or declared wait: the board's own state line. */
  stateLabel: z.string().min(1).max(240),
  /** The recorded wait the task is in, when it is in one. Never inferred from reason text. */
  waitLabel: z.string().min(1).max(240).nullable(),
  prNumber: z.number().int().positive().nullable(),
  prState: z.enum(["OPEN", "CLOSED", "MERGED"]).nullable(),
  prUrl: z.string().max(2048).nullable(),
  /** A task the operator has to look at: an escalated incident or a phase that needs attention. */
  attention: z.boolean(),
  held: z.boolean(),
  /** The Spec 050 stop category, when the task is stopped. */
  stop: z.string().min(1).max(60).nullable(),
}).strict();

export type BbSidebarGroup = z.infer<typeof bbSidebarGroupSchema>;

/** One role thread Nucleus records for a task, so a later surface can find it by environment. */
export const bbSidebarThreadSchema = z.object({
  threadId: z.string().min(1).max(240),
  taskId: z.string().min(1).max(240),
  role: z.string().min(1).max(80),
  environmentId: z.string().min(1).max(240),
}).strict();

export type BbSidebarThread = z.infer<typeof bbSidebarThreadSchema>;

/**
 * Spec 062 decision 5d: one Nucleus project as the BB surfaces resolve it. The
 * route key is the Nucleus project key, never a BB project id: a project spans
 * every repository it lists, and BB holds one project per repository root.
 *
 * `threadIds` are the project's planner and named-agent threads (the threads the
 * per-project tab shows on); `bbProjectIds` are the BB projects Nucleus recorded
 * for the project's repositories (the sidebar's project rows that link to it).
 */
export const bbSidebarProjectSchema = z.object({
  key: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  threadIds: z.array(z.string().min(1).max(300)).max(101),
  bbProjectIds: z.array(z.string().min(1).max(240)).max(100),
}).strict();

export type BbSidebarProject = z.infer<typeof bbSidebarProjectSchema>;

export const bbSidebarGroupsOutputSchema = z.object({
  groups: z.array(bbSidebarGroupSchema),
  threads: z.array(bbSidebarThreadSchema),
  projects: z.array(bbSidebarProjectSchema),
}).strict();

export type BbSidebarGroups = z.infer<typeof bbSidebarGroupsOutputSchema>;
