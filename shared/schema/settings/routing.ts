import { z } from "zod";
import {
  capabilityLevelSchema,
  demandLevelSchema,
  legacyWeightStop,
  profileCapabilitySchema,
  profileWeightSchema,
  scopeSchema,
  weightShare,
} from "./capability";
import { usageViewSchema } from "./usage";

/**
 * How one task's routing reads: the profile each role would use and why, the
 * automatic selection explanation, the requests and their reasons, and
 * the host rules that translated or ruled a profile out. Read-only diagnostics;
 * selection itself is the dispatcher's `chooseProfile`.
 */

/**
 * Spec 052 diagnostics: one profile a task's routing names, read against the
 * usage level in force. `source` says why it is shown: an explicit request
 * (used at every level), a worker preference (still needs a request when
 * `automatic` requires one), or the profile a recorded run used (history, not
 * relabelled by today's level). `gates` lists pool gates beyond the usage
 * policy; catalog availability is checked at dispatch.
 */
const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);

/** A recorded diagnostic row that carried the retired `cost` reads without it (nucleus#1488). */
const routePolicyFromLegacy = (raw: unknown): unknown => {
  if (!isRecord(raw)) return raw;
  const { cost: _retired, signoff: _retiredSignoff, ...rest } = raw;
  return rest;
};

/**
 * A recorded selection row read before nucleus#1488: `cost` and `effectiveWeight`
 * are dropped, a numeric weight reads as its stop, and the share is derived from
 * that stop. Nothing recorded is rewritten.
 */
const selectionFromLegacy = (raw: unknown): unknown => {
  if (!isRecord(raw) || !Array.isArray(raw.met)) return raw;
  return {
    ...raw,
    met: raw.met.map((row) => {
      if (!isRecord(row)) return row;
      const { cost: _cost, effectiveWeight: _effective, ...rest } = row;
      const weight = legacyWeightStop(rest.weight);
      const stop = profileWeightSchema.safeParse(weight);
      return { ...rest, weight, ...(!("share" in rest) && stop.success ? { share: weightShare(stop.data) } : {}) };
    }),
  };
};

const routePolicyShape = z
  .object({
    role: z.enum(["worker", "reviewer", "coordinator"]),
    profileId: z.string(),
    source: z.enum(["request", "preference", "dispatched"]),
    inPool: z.boolean(),
    /** The pool entry's capability; a top-tier profile needs permission at Low and Normal (Spec 052). */
    capability: profileCapabilitySchema.nullable().optional(),
    /** Null when the profile is not in the pool: automatic selection never reaches it. */
    automatic: z.enum(["allowed", "request_tier"]).nullable(),
    explanation: z.string(),
    gates: z.array(z.string()),
    reason: z.string().optional(),
  })
  .strict();

export const routePolicySchema = z.preprocess(routePolicyFromLegacy, routePolicyShape) as unknown as typeof routePolicyShape;

export type RoutePolicy = z.infer<typeof routePolicySchema>;

/**
 * One enabled pool profile the task's host rules out, or runs with values its
 * table spells differently (nucleus#1151, task 1158), so "why did this get Luna?"
 * has an answer on the task.
 */
export const hostEffectSchema = z
  .object({
    profileId: z.string(),
    name: z.string(),
    effect: z.enum(["unavailable", "translated"]),
    /** The host's reason for a ruled-out profile, or what the launch sends. */
    reason: z.string(),
  })
  .strict();
export type HostEffect = z.infer<typeof hostEffectSchema>;

/**
 * How automatic worker selection reads for this task now (nucleus#1151): the
 * demand it computes, the profiles that meet it on the task's host, and why the
 * leading one wins. Read-only: selection itself is `chooseProfile`.
 */
const selectionExplanationShape = z
  .object({
    role: z.literal("worker"),
    complexity: capabilityLevelSchema,
    /** The tier this usage level starts a task of this complexity at (`workerStartTier`). */
    startTier: demandLevelSchema,
    /** How the first-attempt and step-up rules apply at dispatch (`workerStepLabel`). */
    step: z.string(),
    fullDemand: demandLevelSchema,
    demand: demandLevelSchema,
    /** No eligible profile met the demand, so the most capable eligible ones form the set. */
    shortfall: z.boolean(),
    /** The set rotation chooses from, best placed first: recent use over relative share. */
    met: z.array(
      z
        .object({
          profileId: z.string(),
          name: z.string(),
          capability: z.string().nullable(),
          weight: profileWeightSchema,
          /** The weight stop's relative rotation share (Default is 1); never an admission rule. */
          share: z.number(),
          recent: z.number(),
        })
        .strict(),
    ),
    /** The profile selection would choose now, and why; null when none is eligible. */
    choice: z
      .object({ profileId: z.string(), name: z.string(), reason: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export const selectionExplanationSchema = z.preprocess(selectionFromLegacy, selectionExplanationShape) as unknown as typeof selectionExplanationShape;
export type SelectionExplanation = z.infer<typeof selectionExplanationSchema>;

export const routingPolicySchema = z
  .object({
    usage: usageViewSchema,
    /** The task's own requested tier, which the tier bound and the climb exception read. */
    requested: demandLevelSchema,
    /** The tier a recorded climb earned, or null before any climb (the permission exception). */
    climbTier: demandLevelSchema.nullable().default(null),
    scope: scopeSchema,
    profiles: z.array(routePolicySchema),
    selection: selectionExplanationSchema.optional(),
    /** The task's host and the pool profiles it rules out or maps; absent when no host snapshot was read. */
    host: z
      .object({ hostId: z.string(), effects: z.array(hostEffectSchema) })
      .strict()
      .optional(),
    hostSelection: z
      .object({ hostId: z.string(), reason: z.string() })
      .strict()
      .optional(),
    hosts: z
      .array(
        z
          .object({
            hostId: z.string(),
            online: z.boolean(),
            profiles: z.array(
              z
                .object({
                  profileId: z.string(),
                  eligible: z.boolean(),
                  reason: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const profileRequestSchema = z
  .object({
    profileId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(4000),
    required: z.boolean().default(false),
    /** Spec 050: route-only origin marker. Only the owner `route` verb writes `ownerRoute: true`; `set_routing` and submissions are stripped at their writers, so the reviewer independence waiver applies only to an owner route with a recorded `owner_control` event. */
    ownerRoute: z.boolean().optional(),
    /** When an owner `route` recorded this request. */
    routedAt: z.string().optional(),
    /** Spec 050: thinking override for this role's next run. */
    thinkingOptionId: z.string().optional(),
    /** Who recorded the request: the routing caller, or the submitting origin for a brief. */
    requestedBy: z.string().max(300).optional(),
  })
  .strict();

export const profileRequestsSchema = z
  .object({
    worker: profileRequestSchema.optional(),
    reviewer: profileRequestSchema.optional(),
    coordinator: profileRequestSchema.optional(),
  })
  .strict();

export const routingProfileRequestsSchema = z
  .object({
    worker: profileRequestSchema.nullable().optional(),
    reviewer: profileRequestSchema.nullable().optional(),
    coordinator: profileRequestSchema.nullable().optional(),
  })
  .strict();
