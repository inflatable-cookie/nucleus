import { defineRpc } from "../rpc";
import { telemetryFilterSchema, telemetrySnapshotSchema } from "../telemetry";
import { z } from "zod";
import { capacityAuthorityStateSchema, capacitySchema, demandRoleOffsetsSchema, poolRecordFromLegacy, poolSchema, routingGrantViewSchema, usageLevelSchema, usageViewSchema } from "../schema/settings";
import { nucleusProfileInputSchema, nucleusProfileSchema, nucleusProfileUpdateSchema } from "../profiles";
import { hostCatalogSchema, storedHostCatalogSchema } from "../host";
import { hostKindSchema } from "../host-kind";
import { availabilityMarkSchema } from "../schema/state";
import { projectDispatchLimitSchema } from "../schema/capacity";

export const telemetry = defineRpc({ name: "queue.telemetry", input: telemetryFilterSchema, output: telemetrySnapshotSchema });

export const configurePool = defineRpc({ name: "queue.pool", input: z.object({ entries: z.array(z.preprocess(raw => poolRecordFromLegacy(raw), poolSchema)) }), output: z.object({ ok: z.literal(true) }) });

/**
 * Nucleus's own profile list (Spec 052). Selection uses these stored records
 * with availability computed from the host catalog.
 */
export const listNucleusProfiles = defineRpc({ name: "profile.list", input: z.object({}).strict(), output: z.object({ profiles: z.array(nucleusProfileSchema) }) });

export const createNucleusProfile = defineRpc({ name: "profile.create", input: nucleusProfileInputSchema, output: z.object({ profile: nucleusProfileSchema }) });

export const updateNucleusProfile = defineRpc({ name: "profile.update", input: nucleusProfileUpdateSchema, output: z.object({ profile: nucleusProfileSchema }) });

export const removeNucleusProfile = defineRpc({ name: "profile.remove", input: z.object({ id: z.string().min(1).max(240) }).strict(), output: z.object({ removed: z.boolean() }) });

/** The host catalog: every provider it reports, with models, thinking options, modes and features. */
export const readHostCatalog = defineRpc({ name: "host.catalog", input: z.object({ cwd: z.string().min(1).max(4000).optional(), refresh: z.boolean().optional() }).strict(), output: storedHostCatalogSchema });

/**
 * Settings' profile form choices (task 1158): every registered host's catalog in
 * Nucleus's canonical vocabulary, merged, so each dropdown offers what at least
 * one host can run. Providers, thinking levels and modes are canonical; models are
 * the provider's own ids; features are the provider's own options, less those a
 * host's table uses to carry thinking or a mode. `cwd` and `refresh` read the
 * primary host as `host.catalog` does.
 */
export const readProfileVocabulary = defineRpc({ name: "profile.vocabulary", input: z.object({ cwd: z.string().min(1).max(4000).optional(), refresh: z.boolean().optional() }).strict(), output: storedHostCatalogSchema });

/**
 * Each profile on each registered host (nucleus#1151, task 1158): works or not,
 * the host's reason, the fields that host's table spells differently, and the
 * values a launch there sends. Computed from the catalog Nucleus last read from
 * that host, its adapter's translation table and the stored canonical profiles,
 * so it follows a catalog change and a Settings edit at once. A host whose
 * catalog was never read answers `unknown`.
 */
export const profileCompatibilityRowSchema = z.object({
  profileId: z.string(), hostId: z.string(),
  status: z.enum(["works", "unavailable", "unknown"]),
  reason: z.string(),
  translated: z.array(z.string()),
  launch: z.object({ provider: z.string(), model: z.string(), modeId: z.string().optional(), thinkingOptionId: z.string().optional(), featureValues: z.record(z.string(), z.unknown()).optional() }).strict().nullable(),
}).strict();
export type ProfileCompatibilityRow = z.infer<typeof profileCompatibilityRowSchema>;
export const profileCompatibilityHostSchema = z.object({
  hostId: z.string(), kind: hostKindSchema, label: z.string(), online: z.boolean(),
  readAt: z.string().nullable(),
}).strict();
export type ProfileCompatibilityHost = z.infer<typeof profileCompatibilityHostSchema>;
export const readProfileCompatibility = defineRpc({ name: "profile.compatibility", input: z.object({}).strict(),
  output: z.object({ hosts: z.array(profileCompatibilityHostSchema), rows: z.array(profileCompatibilityRowSchema) }).strict() });

export const configureProfile = defineRpc({name:"queue.profile",input:z.preprocess(raw=>poolRecordFromLegacy(raw),poolSchema),output:z.object({ok:z.literal(true)})});

export const queueControl = defineRpc({ name: "queue.control", input: z.object({ paused: z.boolean().optional(), dispatchHeld: z.boolean().optional() }).strict().refine(input => input.paused !== undefined || input.dispatchHeld !== undefined, "Provide paused or dispatchHeld"), output: z.object({ ok: z.literal(true) }) });

/**
 * Queue #650: the operator's stop-every-active-thread control, available only
 * while Queue is paused. One service method shared by the board and the CLI; it
 * cancels each live Queue-owned turn through the existing durable stop path and
 * records a `paused_stop` marker so unpause resumes every stopped thread.
 */
export const stopThreads = defineRpc({
  name: "queue.stop-threads",
  input: z.object({ caller: z.string().trim().min(1).max(200).optional() }).strict(),
  output: z.object({
    ok: z.literal(true),
    stopped: z.array(z.object({
      taskId: z.string(), runId: z.string().nullable(), agentId: z.string(), role: z.string(),
    }).strict()),
  }).strict(),
});

export const availabilityControl = defineRpc({ name: "queue.availability", input: z.union([
  availabilityMarkSchema,
  z.object({ action: z.literal("remove"), group: z.string().trim().min(1) }).strict(),
]), output: z.object({ ok: z.literal(true) }) });

export const refreshCatalog = defineRpc({ name: "queue.refresh", input: z.object({}), output: z.object({ ok: z.literal(true) }) });

export const configureCapacity = defineRpc({ name: "queue.capacity", input: capacitySchema, output: z.object({ ok: z.literal(true) }) });

export const capacityState = defineRpc({ name: "queue.capacity-state", input: z.object({}).strict(), output: capacityAuthorityStateSchema });

export const configureDemandOffsets = defineRpc({ name: "queue.demand-offsets", input: demandRoleOffsetsSchema, output: demandRoleOffsetsSchema });

export const configureUsage = defineRpc({ name: "queue.usage", input: z.object({ level: usageLevelSchema, until: z.string().datetime({ offset: true }).nullable().optional() }).strict(), output: usageViewSchema });

/** Spec 052: a planner asks for a standing frontier grant; the operator answers on the board; the planner ends it or the operator revokes. */
export const routingGrant = defineRpc({
  name: "queue.routing-grant",
  input: z.object({
    action: z.enum(["request", "end", "revoke"]),
    caller: z.string().trim().min(1).max(300),
    reason: z.string().trim().min(1).max(4000).optional(),
    profiles: z.array(z.string().trim().min(1)).max(32).optional(),
    until: z.string().datetime({ offset: true }).nullable().optional(),
    grantId: z.string().min(1).optional(),
  }).strict().refine(input => input.action !== "request" || Boolean(input.reason?.trim()), "A grant request needs a reason"),
  output: z.object({
    grant: routingGrantViewSchema,
    joined: z.boolean(),
    alreadyActive: z.boolean(),
  }).strict(),
});

export const configureProjectDispatchLimit = defineRpc({ name: "queue.project-dispatch-limit", input: projectDispatchLimitSchema, output: z.object({ ok: z.literal(true) }) });
