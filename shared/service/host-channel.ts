/**
 * Strict schemas for the reverse host-operation channel (Spec 062, phase 0).
 *
 * `shared/host-operation.ts` owns the vocabulary and the identity derivation; this
 * module owns what the service accepts and what it trusts. Every declaration, every
 * operation input and every operation answer is validated here, strictly: a missing
 * required field is a named refusal, never a coerced default, and an unknown field
 * is refused by name because the plugin is not the authority on this wire.
 *
 * The plugin narrows each SDK row to exactly the fields below before it answers, so
 * a BB release that renames or drops a field refuses at this boundary instead of
 * silently reporting a stale shape as current.
 */
import { z } from "zod";
import { formatSchemaRefusal } from "../schema-refusal";
import {
  HOST_EXECUTOR_ROLE,
  HOST_OPERATIONS,
  HOST_PERMISSION_DECISIONS,
  HOST_SEND_MODES,
  type HostExecutorDeclaration,
  type HostOperationFailure,
  type HostOperationName,
  type HostOperationOutcome,
} from "../host-operation";

const boundedText = (max: number) => z.string().min(1).max(max);
const nullableText = (max: number) => boundedText(max).nullable();
const timestamp = z.number().int().nonnegative();

/** The identity a connection declares to become this server's host executor. */
export const hostExecutorDeclarationSchema = z
  .object({
    role: z.literal(HOST_EXECUTOR_ROLE),
    host: z
      .object({
        dataDir: boundedText(4_096),
        bbVersion: boundedText(64),
        sdkVersion: boundedText(64),
        // Spec 062, phase 7: the Nucleus build the installed plugin came from. Optional
        // because a plugin installed from a source checkout carries no identity; the
        // service refuses that against a packaged build instead of a schema error.
        nucleusBuild: z
          .string()
          .regex(/^[a-f0-9]{8,64}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();

export const hostOperationNameSchema = z.enum(HOST_OPERATIONS);

/** One reverse request's input: the operation and its own bounded arguments. */
export const hostOperationRequestSchema = z.object({
  op: hostOperationNameSchema,
  input: z.unknown(),
}).strict();

const terminalScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: boundedText(128) }).strict(),
  z.object({ kind: z.literal("environment"), environmentId: boundedText(128) }).strict(),
  z.object({ kind: z.literal("host_path"), hostId: boundedText(128), cwd: boundedText(4_096).nullable().optional() }).strict(),
]);

const pluginMetadataSchema = z.record(z.string(), z.unknown());

/**
 * Each operation's input. A caller that names an operation with the wrong arguments
 * gets `invalid_input` naming the field, and the plugin never sees the frame.
 */
export const hostOperationInputSchemas = {
  "identity.probe": z.object({}).strict(),
  "workspace.create": z.object({
    repositoryRoot: boundedText(4_096),
    workspacePath: boundedText(4_096).optional(),
    name: boundedText(120),
  }).strict(),
  "workspace.inspect": z.object({ repositoryRoot: boundedText(4_096), projectId: boundedText(128).optional() }).strict(),
  "run.attach": z.object({
    projectId: boundedText(128),
    title: boundedText(200),
    environmentPath: boundedText(4_096),
    reasoningLevel: boundedText(32).optional(),
    permissionMode: boundedText(32).optional(),
    sessionOptions: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    parentThreadId: boundedText(128).optional(),
    parentNotifications: z.enum(["auto", "stuck", "off"]).optional(),
    /** Absent for a support thread that is created idle and receives its prompt by a send. */
    prompt: boundedText(500_000).optional(),
    providerId: boundedText(64).optional(),
    model: boundedText(200).optional(),
    pluginMetadata: pluginMetadataSchema.optional(),
  }).strict(),
  "thread.observe": z.object({ threadId: boundedText(128) }).strict(),
  "thread.stop": z.object({ threadId: boundedText(128) }).strict(),
  "thread.cascade": z.object({
    threadId: boundedText(128),
    action: z.literal("archive"),
  }).strict(),
  "thread.archive": z.object({
    threadId: boundedText(128),
    /**
     * The cascade rows the caller already accepted. An archive whose own cascade
     * read names anything outside this set is refused: a thread Nucleus did not
     * create is never archived (Spec 062, decision 4).
     */
    expectedCascadeThreadIds: z.array(boundedText(128)).max(200),
  }).strict(),
  "thread.inventory": z.object({
    originPluginId: boundedText(128).optional(),
    projectId: boundedText(128).optional(),
    includeHidden: z.boolean().optional(),
    archived: z.boolean().optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
  }).strict(),
  "thread.read": z.object({ threadIds: z.array(boundedText(128)).min(1).max(200) }).strict(),
  "thread.metadata": z.object({ threadIds: z.array(boundedText(128)).min(1).max(200) }).strict(),
  "thread.title": z.object({ threadId: boundedText(128), title: boundedText(200) }).strict(),
  "thread.timeline": z.object({ threadId: boundedText(128) }).strict(),
  "thread.send": z.object({
    threadId: boundedText(128),
    text: boundedText(500_000),
    messageId: boundedText(200),
    /** `queue` (the default) waits behind the live turn; `steer` joins it. */
    mode: z.enum(HOST_SEND_MODES).optional(),
  }).strict(),
  "thread.reparent": z.object({ threadId: boundedText(128), parentThreadId: boundedText(128) }).strict(),
  "thread.interactions": z.object({ threadId: boundedText(128) }).strict(),
  "thread.interaction.respond": z.object({
    threadId: boundedText(128),
    interactionId: boundedText(128),
    answer: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("question"), answers: z.record(z.string(), boundedText(2_000)) }).strict(),
      z.object({ kind: z.literal("permission"), decision: z.enum(HOST_PERMISSION_DECISIONS) }).strict(),
    ]),
  }).strict(),
  "thread.interaction.cancel": z.object({ threadId: boundedText(128), interactionId: boundedText(128) }).strict(),
  "provider.catalog": z.object({}).strict(),
  "environment.list": z.object({}).strict(),
  "terminal.create": z.object({
    scope: terminalScopeSchema,
    title: boundedText(200),
    cols: z.number().int().min(1).max(1_000).optional(),
    rows: z.number().int().min(1).max(1_000).optional(),
  }).strict(),
  "terminal.list": z.object({ scope: terminalScopeSchema }).strict(),
  "terminal.close": z.object({
    terminalId: boundedText(128),
    mode: z.enum(["force", "if-clean"]).optional(),
  }).strict(),
  "call.counters": z.object({}).strict(),
} satisfies Record<HostOperationName, z.ZodType>;

/** The bounded projection each operation answers with; no raw SDK row crosses this wire. */
export const hostOperationValueSchemas = {
  "identity.probe": z.object({
    dataDir: boundedText(4_096),
    bbVersion: boundedText(64),
    sdkVersion: boundedText(64),
    hostIds: z.array(boundedText(128)).max(64),
  }).strict(),
  "workspace.create": z.object({
    projectId: boundedText(128),
    projectCreated: z.boolean(),
    projectCount: z.number().int().nonnegative(),
    handle: z.string().regex(/^bb-worktree-[a-f0-9]{40}$/),
    path: boundedText(4_096),
    /** `threads.spawn` calls this operation made: a workspace step proves zero. */
    spawned: z.number().int().nonnegative(),
  }).strict(),
  "workspace.inspect": z.object({ projectId: nullableText(128), projectFound: z.boolean(), path: nullableText(4_096) }).strict(),
  "run.attach": z.object({
    threadId: boundedText(128),
    environmentId: boundedText(128),
    status: boundedText(32),
    parentThreadId: nullableText(128),
    parentNotifications: boundedText(16),
    pluginMetadata: pluginMetadataSchema.nullable(),
    createdAt: timestamp,
    spawned: z.number().int().positive(),
  }).strict(),
  "thread.observe": bbObservationRowSchema().extend({ pluginMetadata: pluginMetadataSchema.nullable(), execution: z.object({
    model: boundedText(200), permissionMode: boundedText(32), reasoningLevel: boundedText(32),
  }).strict().nullable() }).strict(),
  "thread.stop": z.object({
    threadId: boundedText(128),
    status: boundedText(32),
    displayStatus: boundedText(32),
  }).strict(),
  "thread.cascade": z.object({
    threadId: boundedText(128),
    action: z.literal("archive"),
    cascadeThreadIds: z.array(boundedText(128)).max(200),
  }).strict(),
  "thread.archive": z.object({
    threadId: boundedText(128),
    archivedAt: timestamp,
    cascadeThreadIds: z.array(boundedText(128)).max(200),
  }).strict(),
  "thread.inventory": z.object({
    complete: z.boolean(),
    rows: z.array(bbObservationRowSchema()).max(200),
  }).strict(),
  "thread.read": z.object({ rows: z.array(bbObservationRowSchema()).max(200) }).strict(),
  "thread.metadata": z.object({ threads: z.array(z.object({ threadId: boundedText(128), metadata: pluginMetadataSchema.nullable() }).strict()).max(200) }).strict(),
  "thread.title": z.object({ threadId: boundedText(128), title: nullableText(400) }).strict(),
  "thread.timeline": z.object({ threadId: boundedText(128), hasOlder: z.boolean(), pendingBackgroundTasks: z.array(boundedText(128)).max(32),
    // BB composes thread, row kind and provider call ID; preserve the full identity.
    entries: z.array(z.object({ id: boundedText(4_096), seq: timestamp, at: timestamp, turnId: nullableText(128),
      status: z.enum(["pending", "completed", "error", "interrupted"]), name: boundedText(128) }).strict()).max(2000),
  }).strict(),
  "thread.send": z.object({ threadId: boundedText(128), delivery: z.enum(["sent", "queued"]), mode: z.enum(HOST_SEND_MODES) }).strict(),
  "thread.reparent": z.object({ threadId: boundedText(128), parentThreadId: nullableText(128) }).strict(),
  "thread.interactions": z.object({
    threadId: boundedText(128),
    interactions: z.array(z.object({
      interactionId: boundedText(128),
      kind: boundedText(64),
      status: z.enum(["pending", "resolving", "resolved", "interrupted"]),
      title: nullableText(400),
      questions: z.array(z.object({
        id: boundedText(128),
        header: boundedText(200),
        question: boundedText(2_000),
        /** The label is what an operator reads; the value is what the provider accepts back. */
        options: z.array(z.object({ label: boundedText(400), value: boundedText(400) }).strict()).max(20),
        allowFreeText: z.boolean(),
      }).strict()).max(32).optional(),
      decisions: z.array(z.enum(["allow_once", "allow_for_session", "deny"])).max(8).optional(),
    }).strict()).max(200),
  }).strict(),
  "thread.interaction.respond": z.object({
    threadId: boundedText(128),
    interactionId: boundedText(128),
    status: z.enum(["resolving", "resolved", "interrupted"]),
    resolutionKind: boundedText(64),
  }).strict(),
  "thread.interaction.cancel": z.object({
    threadId: boundedText(128),
    interactionId: boundedText(128),
    status: z.enum(["resolving", "resolved", "interrupted"]),
  }).strict(),
  "provider.catalog": z.object({ providers: z.array(z.object({
    id: boundedText(128), modes: z.array(boundedText(32)).max(16), models: z.array(z.object({ id: boundedText(200), reasoningLevels: z.array(boundedText(32)).max(32) }).strict()).max(1000),
  }).strict()).max(100) }).strict(),
  "environment.list": z.object({
    environments: z.array(z.object({
      environmentId: boundedText(128),
      path: boundedText(4_096),
      isWorktree: z.boolean(),
      status: boundedText(32),
      managed: z.boolean(),
    }).strict()).max(500),
  }).strict(),
  "terminal.create": z.object({ session: hostTerminalSessionSchema() }).strict(),
  "terminal.list": z.object({ sessions: z.array(hostTerminalSessionSchema()).max(500) }).strict(),
  "terminal.close": z.object({ session: hostTerminalSessionSchema() }).strict(),
  "call.counters": z.object({
    counters: z.record(z.string(), z.number().int().nonnegative()),
    loadedAt: timestamp,
  }).strict(),
} satisfies Record<HostOperationName, z.ZodType>;

/** Fields read from BB 0.49's list rows; active turn identity is not a row field. */
function bbObservationRowSchema() {
  return z.object({
    threadId: boundedText(128), title: nullableText(400), providerId: boundedText(128), status: z.enum(["pending", "idle", "starting", "active", "stopping", "error"]),
    displayStatus: boundedText(32), environmentId: nullableText(128), environmentPath: nullableText(4096),
    parentThreadId: nullableText(128), parentNotifications: boundedText(16), originPluginId: nullableText(128),
    archivedAt: timestamp.nullable(), updatedAt: timestamp, queuedWork: z.enum(["none", "waiting", "failed"]),
    hasPendingInteraction: z.boolean(),
    interactions: z.array(z.object({ id: boundedText(128), kind: boundedText(64), status: boundedText(32), title: nullableText(400) }).strict()).max(200),
  }).strict();
}

function hostTerminalSessionSchema() {
  return z.object({
    id: boundedText(128),
    threadId: nullableText(128),
    environmentId: nullableText(128),
    hostId: nullableText(128),
    initialCwd: nullableText(4_096),
    status: boundedText(32),
    closeReason: nullableText(32),
  }).strict();
}

/** One operation answer as it arrives from the plugin. */
export const hostOperationOutcomeSchema = z.object({
  operation: hostOperationNameSchema,
  at: z.string().min(1).max(40),
  calls: z.record(z.string(), z.number().int().nonnegative()),
  value: z.unknown(),
}).strict();

/** One operation refusal as the plugin reports it. */
export const hostOperationFailureSchema = z.object({
  code: z.enum(["invalid_input", "refused", "unavailable", "internal"]),
  message: boundedText(2_000),
}).strict();

export type Parsed<T> = { ok: true; value: T } | { ok: false; failure: HostOperationFailure };

function invalid(message: string): { ok: false; failure: HostOperationFailure } {
  return { ok: false, failure: { code: "invalid_input", message } };
}

export function parseHostExecutorDeclaration(input: unknown): Parsed<HostExecutorDeclaration> {
  const parsed = hostExecutorDeclarationSchema.safeParse(input);
  if (!parsed.success) return invalid(`Host executor declaration refused: ${formatSchemaRefusal(parsed.error)}`);
  return { ok: true, value: parsed.data };
}

export function parseHostOperationRequest(input: unknown): Parsed<{ op: HostOperationName; input: unknown }> {
  const parsed = hostOperationRequestSchema.safeParse(input);
  if (!parsed.success) return invalid(`Host operation request refused: ${formatSchemaRefusal(parsed.error)}`);
  const op = parsed.data.op;
  const narrowed = hostOperationInputSchemas[op].safeParse(parsed.data.input ?? {});
  if (!narrowed.success) return invalid(`Host operation ${op} input refused: ${formatSchemaRefusal(narrowed.error)}`);
  return { ok: true, value: { op, input: narrowed.data } };
}

/**
 * Validate one plugin answer against its own operation. The envelope, the operation
 * name and the projection must all agree: an answer for a different operation, or a
 * projection missing a required field, is a malformed result (unknown delivery for
 * that operation), never a partial success.
 */
export function parseHostOperationOutcome(op: HostOperationName, raw: unknown): Parsed<HostOperationOutcome> {
  const envelope = hostOperationOutcomeSchema.safeParse(raw);
  if (!envelope.success) return invalid(`Host operation ${op} answer refused: ${formatSchemaRefusal(envelope.error)}`);
  if (envelope.data.operation !== op) return invalid(`Host operation answer named ${envelope.data.operation}, expected ${op}`);
  const value = hostOperationValueSchemas[op].safeParse(envelope.data.value);
  if (!value.success) return invalid(`Host operation ${op} result refused: ${formatSchemaRefusal(value.error)}`);
  return { ok: true, value: { ...envelope.data, value: value.data } };
}

export function parseHostOperationFailure(input: unknown): HostOperationFailure | null {
  const parsed = hostOperationFailureSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
