import { defineRpc } from "../rpc";
import { telemetryFilterSchema, telemetrySnapshotSchema } from "../telemetry";
import { z } from "zod";
import { capacityAuthorityStateSchema, capacitySchema, demandRoleOffsetsSchema, poolRecordFromLegacy, poolSchema, routingGrantViewSchema, usageLevelSchema, usageViewSchema } from "../schema/settings";
import { nucleusProfileInputSchema, nucleusProfileSchema, nucleusProfileUpdateSchema, providerMapSchema } from "../profiles";
import { storedHostCatalogSchema } from "../host";
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

/** The host provider key to normalised key map a profile's provider is read through. */
export const readProviderMap = defineRpc({ name: "profile.providers", input: z.object({}).strict(), output: z.object({ providers: providerMapSchema }) });

/**
 * Replace that map from Settings' small editor; `{}` is identity, which is what
 * Paseo's own keys are, so a host only needs an entry when it spells a provider
 * differently (Tom, 2026-11-07).
 */
export const writeProviderMap = defineRpc({ name: "profile.providers.set", input: z.object({ providers: providerMapSchema }).strict(), output: z.object({ providers: providerMapSchema }) });

/** The host catalog: every provider it reports, with models, thinking options, modes and features. */
export const readHostCatalog = defineRpc({ name: "host.catalog", input: z.object({ cwd: z.string().min(1).max(4000).optional(), refresh: z.boolean().optional() }).strict(), output: storedHostCatalogSchema });

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
