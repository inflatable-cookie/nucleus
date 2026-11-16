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
  type HostExecutorDeclaration,
  type HostOperationFailure,
  type HostOperationName,
  type HostOperationOutcome,
} from "../host-operation";

const boundedText = (max: number) => z.string().min(1).max(max);
const nullableText = (max: number) => boundedText(max).nullable();
const timestamp = z.number().int().nonnegative();

/** The identity a connection declares to become this server's host executor. */
export const hostExecutorDeclarationSchema = z.object({
  role: z.literal(HOST_EXECUTOR_ROLE),
  host: z.object({
    dataDir: boundedText(4_096),
    bbVersion: boundedText(64),
    sdkVersion: boundedText(64),
  }).strict(),
}).strict();

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
    name: boundedText(120),
  }).strict(),
  "run.attach": z.object({
    projectId: boundedText(128),
    title: boundedText(200),
    environmentPath: boundedText(4_096),
    parentThreadId: boundedText(128).optional(),
    parentNotifications: z.enum(["auto", "stuck", "off"]).optional(),
    prompt: boundedText(20_000),
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
  }).strict(),
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
  "thread.observe": z.object({
    threadId: boundedText(128),
    title: nullableText(400),
    status: boundedText(32),
    displayStatus: boundedText(32),
    environmentId: nullableText(128),
    parentThreadId: nullableText(128),
    parentNotifications: boundedText(16),
    pluginMetadata: pluginMetadataSchema.nullable(),
    archivedAt: z.number().int().nonnegative().nullable(),
    queuedWork: nullableText(32),
  }).strict(),
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
    rows: z.array(z.object({
      threadId: boundedText(128),
      status: boundedText(32),
      environmentId: nullableText(128),
      parentThreadId: nullableText(128),
      originPluginId: nullableText(128),
      archivedAt: z.number().int().nonnegative().nullable(),
      hasPendingInteraction: z.boolean(),
    }).strict()).max(2_000),
  }).strict(),
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
