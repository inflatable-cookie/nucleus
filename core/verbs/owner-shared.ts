import { z } from "zod";
import { taskControlInputSchema, type Task, type TaskControlInput, type TaskNextVerb } from "../../shared/contracts";
import type { OwnerVerbFacts } from './owner-facts';

export type OwnerVerbApplicability =
  | { available: true; args: Record<string, unknown>; fill?: string[]; note?: string }
  | { available: false; refusal: string };

export interface OwnerVerb {
  verb: string;
  /** The `queue.task` action this verb applies through until a native verb replaces it. */
  action: TaskControlInput["action"];
  /** The verb's own arguments beyond `taskId` and `version`. */
  input: z.ZodType;
  applicable: (facts: OwnerVerbFacts) => OwnerVerbApplicability;
  /**
   * Apply the mapped control. `call` is the engine's task-control entry: a
   * native verb runs its bookkeeping inside that transaction, a mapped verb
   * hands the derived arguments to its existing action unchanged.
   */
  apply: (call: (input: TaskControlInput) => Promise<Task>, args: Record<string, unknown>) => Promise<Task>;
  /**
   * Native verbs whose one verb maps to more than one read view (Spec 050
   * `route`, one per role) override the default one-view mapping.
   */
  views?: (facts: OwnerVerbFacts) => TaskNextVerb[];
}

export const verbInput = (fields: Record<string, z.ZodType>) =>
  z.object({ taskId: z.string(), version: z.number(), ...fields }).strict();

/** Shared apply for mapped verbs: validate the derived arguments, then call the existing action. */
export const applyMapped = (action: TaskControlInput["action"]) =>
  (call: (input: TaskControlInput) => Promise<Task>, args: Record<string, unknown>): Promise<Task> =>
    call(taskControlInputSchema.parse({ action, ...args }) as TaskControlInput);

export const routeRoles = ["worker", "reviewer", "coordinator"] as const;

export type RouteRole = typeof routeRoles[number];

/**
 * nucleus#1195: `restart` also names the proof-execution role, whose one
 * continuation asks a live executor to resend its report. `route` keeps the
 * three route roles: a proof executor is never routed or replaced this way.
 */
export const restartRoles = [...routeRoles, "executor"] as const;

export type RestartRole = typeof restartRoles[number];

