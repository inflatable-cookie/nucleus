import { z } from "zod";

/** UTF-8 byte length without Node Buffer, so the shared surface stays runtime-neutral. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// Generic repository hook surface, frozen by docs/knowledge/specs/001-generic-repository-hooks.md.
// Queue treats document identity, event payloads and hook results as opaque data.

export const HOOK_MANIFEST_PATH = ".paseo/queue.json";
export const CONTROL_SCHEMA = "paseo.queue.control.v1";
export const CONTROL_SCHEMA_V2 = "paseo.queue.control.v2";
export const CONTROL_SCHEMA_V3 = "paseo.queue.control.v3";
export const CONTROL_SCHEMA_V4 = "paseo.queue.control.v4";
export const CONTROL_SCHEMA_V5 = "paseo.queue.control.v5";
export const CONTROL_SCHEMA_V6 = "paseo.queue.control.v6";
export const CONTROL_SCHEMA_V7 = "paseo.queue.control.v7";
export const CLOSEOUT_SELECTION_SCHEMA = z.enum(["queue", "hooks"]);
export type CloseoutSelection = z.infer<typeof CLOSEOUT_SELECTION_SCHEMA>;
export const RESERVED_VALIDATION_MESSAGE = "validation is reserved for Spec 042 item 3 (plain-validation pre-merge) and is not available until that capability ships";
export const QUEUE_CLOSEOUT_HOOK_MESSAGE = "closeout: \"queue\" cannot be combined with a task.closeout hook";
export const EVENT_SCHEMA = "paseo.queue.event.v1";
export const EVENT_SCHEMA_V2 = "paseo.queue.event.v2";
export const EVENT_SCHEMA_V3 = "paseo.queue.event.v3";
export const EVENT_SCHEMA_V4 = "paseo.queue.event.v4";
export const RESULT_SCHEMA = "paseo.queue.hook-result.v1";
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const METADATA_MAX_BYTES = 32 * 1024;
export const SUMMARY_MAX_BYTES = 4000;

/** A normalized repository-relative POSIX path: no empty, dot or parent segment. */
export function normalizeRepoRelativePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new Error("Repository path must be repository-relative POSIX syntax");
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) throw new Error("Repository path contains an empty, dot or parent segment");
  return path;
}

/** A normalized exact file path or tree prefix ending `/`, as allowed by the manifest. */
export function normalizeAllowedPath(path: string): string {
  if (path.endsWith("/")) {
    const base = path.slice(0, -1);
    if (!base) throw new Error("Tree prefix needs a name");
    return `${normalizeRepoRelativePath(base)}/`;
  }
  return normalizeRepoRelativePath(path);
}

/** True when `path` is named exactly or lives under a declared tree prefix. */
export function pathIsAllowed(path: string, allowed: readonly string[]): boolean {
  return allowed.some(entry => entry.endsWith("/") ? path.startsWith(entry) : path === entry);
}

export function changedPathsAreSortedUnique(paths: readonly string[]): boolean {
  for (let index = 1; index < paths.length; index++) if (paths[index - 1] >= paths[index]) return false;
  return true;
}

export const repoRelativePathSchema = z.string().min(1).max(1024)
  .refine(path => { try { return normalizeRepoRelativePath(path) === path; } catch { return false; } }, "Repository path must be normalized and repository-relative");

export const allowedPathSchema = z.string().min(1).max(1024)
  .refine(path => { try { return normalizeAllowedPath(path) === path; } catch { return false; } }, "Allowed path must be a normalized file path or tree prefix");

export const mediaTypeSchema = z.string().min(1).max(200)
  .refine(value => /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[ -~]*)?$/.test(value) && utf8Length(value) <= 200, "Media type must be a lower-case opaque type with optional parameters");

export const instructionArtifactSchema = z.object({
  path: repoRelativePathSchema,
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mediaType: mediaTypeSchema,
}).strict();
export type InstructionArtifact = z.infer<typeof instructionArtifactSchema>;

// v1 and v2 manifests keep their frozen event surface. Spec 007 added
// `task.pre_merge` to the v3 generation; the pre-archive retention gate adds
// `task.pre_archive` in v6 and leaves every earlier generation's accepted event
// set exactly as it shipped.
const legacyHookEventNames = ["task.pre_dispatch", "task.blocked", "task.cancelled", "task.closeout"] as const;
/** The frozen v3-v5 event surface: `task.pre_merge` but not `task.pre_archive`. */
export const preMergeHookEventNames = [...legacyHookEventNames, "task.pre_merge"] as const;
/** The frozen v6 event surface: adds `task.pre_archive` but not the finished-task stop. */
export const preArchiveHookEventNames = [...preMergeHookEventNames, "task.pre_archive"] as const;
/** The current (v7) event surface, which also carries the finished-task runtime stop. */
export const hookEventNameSchema = z.enum([...preArchiveHookEventNames, "task.finished"]);
export type HookEventName = z.infer<typeof hookEventNameSchema>;
const legacyHookEventNameSchema = z.enum(legacyHookEventNames);
const preMergeHookEventNameSchema = z.enum(preMergeHookEventNames);
const preArchiveHookEventNameSchema = z.enum(preArchiveHookEventNames);

/**
 * Required integration-base events that an exact-identity base-advance race may
 * replay automatically. Reviewed heads and pre-dispatch validation stay out.
 */
export const automaticReplayEventNames = ["task.blocked", "task.cancelled", "task.closeout"] as const;
export const hookEventSupportsAutomaticReplay = (event: HookEventName): boolean =>
  (automaticReplayEventNames as readonly HookEventName[]).includes(event);
/** At most two automatic base-advance replays for one logical event. */
export const AUTOMATIC_REPLAY_LIMIT = 2;
/** One failed automatic proof is not repeated at an unchanged base before this interval. */
export const AUTOMATIC_REPLAY_RETRY_MS = 60_000;

export const hookTargetSchema = z.enum(["integration_base", "reviewed_head"]);
export type HookTarget = z.infer<typeof hookTargetSchema>;
/**
 * Spec 015 adds the closed prospective-merge target. It exists only in
 * `paseo.queue.control.v4`; v1-v3 hooks keep the frozen two-target surface and
 * `reviewed_head` keeps its exact branch-local meaning.
 */
export const prospectiveMergeTargetSchema = z.enum(["integration_base", "reviewed_head", "prospective_merge"]);
export type AnyHookTarget = z.infer<typeof prospectiveMergeTargetSchema>;
export const hookModeSchema = z.enum(["read_only", "integration_write"]);
export const hookDeliverySchema = z.enum(["required", "advisory"]);
export type HookMode = z.infer<typeof hookModeSchema>;
export type HookDelivery = z.infer<typeof hookDeliverySchema>;
export const hookStateSchema = z.enum(["intent", "workspace_intent", "running", "result", "commit_intent", "committed", "push_intent", "sync_intent", "synced", "cleanup_intent", "published", "blocked", "failed", "uncertain"]);
export type HookState = z.infer<typeof hookStateSchema>;
export const TERMINAL_HOOK_STATES: readonly HookState[] = ["result", "published", "blocked", "failed"];
export const hookStateIsTerminal = (state: HookState) => TERMINAL_HOOK_STATES.includes(state);

export const hookIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const commitSubjectSchema = z.object({
  prefix: z.string().min(1).max(50).refine(value => /^[\x20-\x7e]+$/.test(value) && utf8Length(value) <= 50, "Commit subject prefix must be printable ASCII within 50 bytes"),
  maxBytes: z.number().int().min(20).max(100),
}).strict();
export type CommitSubject = z.infer<typeof commitSubjectSchema>;

const argvValueSchema = z.string().refine(value => !value.includes("\0") && utf8Length(value) <= 1024, "argv values must be NUL-free UTF-8 within 1 KiB");

export const repositoryProgramSchema = z.object({
  kind: z.literal("repository"), executable: repoRelativePathSchema,
  argv: z.array(argvValueSchema).max(32).default([]),
}).strict();
export const trustedRunnerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const toolNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, "Tool name must be a plain name without slashes or interpolation");
export const toolProgramSchema = z.object({ kind: z.literal("tool"), name: toolNameSchema, argv: z.array(argvValueSchema).max(32).default([]) }).strict();
// Old manifests retain their meaning without retaining the approval registry.
const legacyToolProgramSchema = z.object({ kind: z.literal("trusted_runner"), runner: toolNameSchema, argv: z.array(argvValueSchema).max(32).default([]) }).strict()
  .transform(value => ({ kind: "tool" as const, name: value.runner, argv: value.argv }));
export const hookProgramSchema = z.union([repositoryProgramSchema, toolProgramSchema, legacyToolProgramSchema]);
export type HookProgram = z.infer<typeof hookProgramSchema>;

interface HookIssueContext { addIssue(issue: { code: "custom"; path: (string | number)[]; message: string }): void }

/** Shared closed binding rules for every manifest generation. */
function refineHookBindings(hook: {
  events: readonly HookEventName[]; mode: HookMode; delivery: HookDelivery;
  allowedPaths: readonly string[]; commitSubject: CommitSubject | null; target?: AnyHookTarget;
}, ctx: HookIssueContext) {
  const reviewedHead = hook.events.includes("task.pre_merge");
  const preArchive = hook.events.includes("task.pre_archive");
  const finished = hook.events.includes("task.finished");
  if (new Set(hook.events).size !== hook.events.length) ctx.addIssue({ code: "custom", path: ["events"], message: "Each event may be bound at most once per hook" });
  if (hook.mode === "read_only" && hook.allowedPaths.length) ctx.addIssue({ code: "custom", path: ["allowedPaths"], message: "read_only hooks may not declare allowed paths" });
  if (hook.mode === "read_only" && hook.commitSubject) ctx.addIssue({ code: "custom", path: ["commitSubject"], message: "read_only hooks may not declare a commit subject" });
  if (hook.events.includes("task.pre_dispatch") && hook.mode !== "read_only") ctx.addIssue({ code: "custom", path: ["mode"], message: "task.pre_dispatch accepts only read_only hooks" });
  if (hook.mode === "integration_write" && !hook.commitSubject) ctx.addIssue({ code: "custom", path: ["commitSubject"], message: "integration_write hooks require a commit subject" });
  if (hook.target) {
    if (reviewedHead && hook.target === "integration_base") ctx.addIssue({ code: "custom", path: ["target"], message: "task.pre_merge requires target reviewed_head or prospective_merge" });
    if (!reviewedHead && hook.target !== "integration_base") ctx.addIssue({ code: "custom", path: ["target"], message: "Only task.pre_merge may target the reviewed head" });
  }
  if (reviewedHead) {
    if (hook.events.length !== 1) ctx.addIssue({ code: "custom", path: ["events"], message: "task.pre_merge must be the only event on its hook" });
    if (hook.mode !== "read_only") ctx.addIssue({ code: "custom", path: ["mode"], message: "task.pre_merge accepts only read_only hooks" });
    if (hook.delivery !== "required") ctx.addIssue({ code: "custom", path: ["delivery"], message: "task.pre_merge requires required delivery" });
  }
  // The retention gate observes the retained task worktree and must never
  // acquire write authority, so it is a lone required read-only hook.
  if (preArchive) {
    if (hook.events.length !== 1) ctx.addIssue({ code: "custom", path: ["events"], message: "task.pre_archive must be the only event on its hook" });
    if (hook.mode !== "read_only") ctx.addIssue({ code: "custom", path: ["mode"], message: "task.pre_archive accepts only read_only hooks" });
    if (hook.delivery !== "required") ctx.addIssue({ code: "custom", path: ["delivery"], message: "task.pre_archive requires required delivery" });
  }
  // The finished-task runtime stop observes the retained task worktree. It is
  // advisory by contract: a failure, timeout or uncertainty is a warning on the
  // task history and must never hold the terminal transition, so required
  // delivery is refused rather than left to the caller to ignore.
  if (finished) {
    if (hook.mode !== "read_only") ctx.addIssue({ code: "custom", path: ["mode"], message: "task.finished accepts only read_only hooks" });
    if (hook.delivery !== "advisory") ctx.addIssue({ code: "custom", path: ["delivery"], message: "task.finished is advisory: required delivery is not available" });
  }
  for (const [index, path] of hook.allowedPaths.entries()) {
    const forbidden = path === ".git" || path.startsWith(".git/") || path === ".paseo" || path === ".paseo/"
      || path === HOOK_MANIFEST_PATH || (path.endsWith("/") && HOOK_MANIFEST_PATH.startsWith(path))
      || path === ".paseo/hooks" || path.startsWith(".paseo/hooks/");
    if (forbidden) ctx.addIssue({ code: "custom", path: ["allowedPaths", index], message: `Reserved path may not be declared: ${path}` });
  }
}

export const hookDefinitionSchema = z.object({
  id: hookIdSchema,
  events: z.array(legacyHookEventNameSchema).min(1).max(4),
  mode: hookModeSchema,
  delivery: hookDeliverySchema,
  executable: repoRelativePathSchema,
  argv: z.array(argvValueSchema).max(32).default([]),
  timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576),
  allowedPaths: z.array(allowedPathSchema).max(64).default([]),
  commitSubject: commitSubjectSchema.nullable().default(null),
}).strict().superRefine(refineHookBindings);
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;

const hookDefinitionV2Schema = z.object({
  id: hookIdSchema, events: z.array(legacyHookEventNameSchema).min(1).max(4), mode: hookModeSchema, delivery: hookDeliverySchema,
  program: hookProgramSchema, timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576), allowedPaths: z.array(allowedPathSchema).max(64).default([]),
  commitSubject: commitSubjectSchema.nullable().default(null),
}).strict().superRefine(refineHookBindings);
export type HookDefinitionV2 = z.infer<typeof hookDefinitionV2Schema>;

/** v3 adds one closed target; `task.pre_merge` requires the reviewed head. */
const hookDefinitionV3Schema = z.object({
  id: hookIdSchema, events: z.array(preMergeHookEventNameSchema).min(1).max(4), mode: hookModeSchema, delivery: hookDeliverySchema,
  target: hookTargetSchema, program: hookProgramSchema, timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576), allowedPaths: z.array(allowedPathSchema).max(64).default([]),
  commitSubject: commitSubjectSchema.nullable().default(null),
}).strict().superRefine(refineHookBindings);
export type HookDefinitionV3 = z.infer<typeof hookDefinitionV3Schema>;

/** v4 adds the closed prospective-merge target; `task.pre_merge` may use either pre-merge target. */
const hookDefinitionV4Schema = z.object({
  id: hookIdSchema, events: z.array(preMergeHookEventNameSchema).min(1).max(4), mode: hookModeSchema, delivery: hookDeliverySchema,
  target: prospectiveMergeTargetSchema, program: hookProgramSchema, timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576), allowedPaths: z.array(allowedPathSchema).max(64).default([]),
  commitSubject: commitSubjectSchema.nullable().default(null),
}).strict().superRefine(refineHookBindings);
export type HookDefinitionV4 = z.infer<typeof hookDefinitionV4Schema>;

/** v6 keeps v4's closed target surface and adds the pre-archive retention gate. */
const hookDefinitionV6Schema = z.object({
  id: hookIdSchema, events: z.array(preArchiveHookEventNameSchema).min(1).max(4), mode: hookModeSchema, delivery: hookDeliverySchema,
  target: prospectiveMergeTargetSchema, program: hookProgramSchema, timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576), allowedPaths: z.array(allowedPathSchema).max(64).default([]),
  commitSubject: commitSubjectSchema.nullable().default(null),
}).strict().superRefine(refineHookBindings);
export type HookDefinitionV6 = z.infer<typeof hookDefinitionV6Schema>;

/** v7 keeps v6's surface and adds the advisory finished-task runtime stop. */
const hookDefinitionV7Schema = z.object({
  id: hookIdSchema, events: z.array(hookEventNameSchema).min(1).max(4), mode: hookModeSchema, delivery: hookDeliverySchema,
  target: prospectiveMergeTargetSchema, program: hookProgramSchema, timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576), allowedPaths: z.array(allowedPathSchema).max(64).default([]),
  commitSubject: commitSubjectSchema.nullable().default(null),
}).strict().superRefine(refineHookBindings);
export type HookDefinitionV7 = z.infer<typeof hookDefinitionV7Schema>;

const controlManifestV1Schema = z.object({
  schema: z.literal(CONTROL_SCHEMA),
  hooks: z.array(hookDefinitionSchema).max(16),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, hook] of manifest.hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
});
const controlManifestV2Schema = z.object({
  schema: z.literal(CONTROL_SCHEMA_V2), hooks: z.array(hookDefinitionV2Schema).max(16),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, hook] of manifest.hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
});
const controlManifestV3Schema = z.object({
  schema: z.literal(CONTROL_SCHEMA_V3), hooks: z.array(hookDefinitionV3Schema).max(16),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, hook] of manifest.hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
});
const controlManifestV4Schema = z.object({
  schema: z.literal(CONTROL_SCHEMA_V4), hooks: z.array(hookDefinitionV4Schema).max(16),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, hook] of manifest.hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
});
/** v5 keeps v4 hook definitions, makes hooks optional, and adds closeout selection. */
const controlManifestV5ObjectSchema = z.object({
  schema: z.literal(CONTROL_SCHEMA_V5),
  closeout: CLOSEOUT_SELECTION_SCHEMA.default("hooks"),
  hooks: z.array(hookDefinitionV4Schema).max(16).default([]),
}).passthrough().superRefine((manifest, ctx) => {
  if ("validation" in manifest) ctx.addIssue({ code: "custom", path: ["validation"], message: RESERVED_VALIDATION_MESSAGE });
  for (const key of Object.keys(manifest)) {
    if (!["schema", "closeout", "hooks", "validation"].includes(key))
      ctx.addIssue({ code: "custom", path: [key], message: `Unrecognized key: "${key}"` });
  }
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks as HookDefinitionV4[] : [];
  const ids = new Set<string>();
  for (const [index, hook] of hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
  if (manifest.closeout === "queue" && hooks.some(hook => hook.events.includes("task.closeout")))
    ctx.addIssue({ code: "custom", path: ["closeout"], message: QUEUE_CLOSEOUT_HOOK_MESSAGE });
});
const controlManifestV5Schema = controlManifestV5ObjectSchema.transform(({ schema, closeout, hooks }) => ({ schema, closeout, hooks }));
/** v6 keeps v5's closeout selection and adds the pre-archive retention gate to the hook surface. */
const controlManifestV6ObjectSchema = z.object({
  schema: z.literal(CONTROL_SCHEMA_V6),
  closeout: CLOSEOUT_SELECTION_SCHEMA.default("hooks"),
  hooks: z.array(hookDefinitionV6Schema).max(16).default([]),
}).passthrough().superRefine((manifest, ctx) => {
  if ("validation" in manifest) ctx.addIssue({ code: "custom", path: ["validation"], message: RESERVED_VALIDATION_MESSAGE });
  for (const key of Object.keys(manifest)) {
    if (!["schema", "closeout", "hooks", "validation"].includes(key))
      ctx.addIssue({ code: "custom", path: [key], message: `Unrecognized key: "${key}"` });
  }
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks as HookDefinitionV6[] : [];
  const ids = new Set<string>();
  for (const [index, hook] of hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
  if (manifest.closeout === "queue" && hooks.some(hook => hook.events.includes("task.closeout")))
    ctx.addIssue({ code: "custom", path: ["closeout"], message: QUEUE_CLOSEOUT_HOOK_MESSAGE });
});
const controlManifestV6Schema = controlManifestV6ObjectSchema.transform(({ schema, closeout, hooks }) => ({ schema, closeout, hooks }));
/** v7 keeps v6's closeout selection and adds the finished-task runtime stop to the hook surface. */
const controlManifestV7ObjectSchema = z.object({
  schema: z.literal(CONTROL_SCHEMA_V7),
  closeout: CLOSEOUT_SELECTION_SCHEMA.default("hooks"),
  hooks: z.array(hookDefinitionV7Schema).max(16).default([]),
}).passthrough().superRefine((manifest, ctx) => {
  if ("validation" in manifest) ctx.addIssue({ code: "custom", path: ["validation"], message: RESERVED_VALIDATION_MESSAGE });
  for (const key of Object.keys(manifest)) {
    if (!["schema", "closeout", "hooks", "validation"].includes(key))
      ctx.addIssue({ code: "custom", path: [key], message: `Unrecognized key: "${key}"` });
  }
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks as HookDefinitionV7[] : [];
  const ids = new Set<string>();
  for (const [index, hook] of hooks.entries()) {
    if (ids.has(hook.id)) ctx.addIssue({ code: "custom", path: ["hooks", index, "id"], message: `Duplicate hook id: ${hook.id}` });
    ids.add(hook.id);
  }
  if (manifest.closeout === "queue" && hooks.some(hook => hook.events.includes("task.closeout")))
    ctx.addIssue({ code: "custom", path: ["closeout"], message: QUEUE_CLOSEOUT_HOOK_MESSAGE });
});
const controlManifestV7Schema = controlManifestV7ObjectSchema.transform(({ schema, closeout, hooks }) => ({ schema, closeout, hooks }));
export const controlManifestSchema = z.union([controlManifestV1Schema, controlManifestV2Schema, controlManifestV3Schema, controlManifestV4Schema, controlManifestV5Schema, controlManifestV6Schema, controlManifestV7Schema]);
export type ControlManifest = z.infer<typeof controlManifestSchema>;

/** True for the manifest generations that carry the explicit `closeout` selection (v5 and later). */
export const manifestSupportsCloseoutSelection = (schema: NormalizedControlManifest["schema"]): boolean =>
  schema === CONTROL_SCHEMA_V5 || schema === CONTROL_SCHEMA_V6 || schema === CONTROL_SCHEMA_V7;

export interface NormalizedHookDefinition {
  id: string; events: HookEventName[]; mode: HookMode; delivery: HookDelivery;
  program: HookProgram; timeoutMs: number; maxOutputBytes: number;
  allowedPaths: string[]; commitSubject: CommitSubject | null; target: AnyHookTarget;
}
export interface NormalizedControlManifest {
  schema: typeof CONTROL_SCHEMA | typeof CONTROL_SCHEMA_V2 | typeof CONTROL_SCHEMA_V3 | typeof CONTROL_SCHEMA_V4 | typeof CONTROL_SCHEMA_V5 | typeof CONTROL_SCHEMA_V6 | typeof CONTROL_SCHEMA_V7;
  closeout: CloseoutSelection;
  hooks: NormalizedHookDefinition[];
}
export function normalizeControlManifest(manifest: ControlManifest | NormalizedControlManifest): NormalizedControlManifest {
  return {
    schema: manifest.schema,
    closeout: "closeout" in manifest && manifest.closeout === "queue" ? "queue" : "hooks",
    hooks: manifest.hooks.map(hook => {
      const target: AnyHookTarget = "target" in hook && hook.target ? hook.target : "integration_base";
      if ("program" in hook) return { id: hook.id, events: hook.events, mode: hook.mode, delivery: hook.delivery,
        program: hook.program, timeoutMs: hook.timeoutMs, maxOutputBytes: hook.maxOutputBytes,
        allowedPaths: hook.allowedPaths, commitSubject: hook.commitSubject, target };
      const legacy = hook as HookDefinition;
      return { id: legacy.id, events: legacy.events, mode: legacy.mode, delivery: legacy.delivery,
        program: { kind: "repository" as const, executable: legacy.executable, argv: legacy.argv },
        timeoutMs: legacy.timeoutMs, maxOutputBytes: legacy.maxOutputBytes, allowedPaths: legacy.allowedPaths, commitSubject: legacy.commitSubject, target };
    }),
  };
}

export const hookPinSchema = z.object({ path: repoRelativePathSchema, commit: z.string().regex(/^[a-f0-9]{40}$/), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export type HookPin = z.infer<typeof hookPinSchema>;

export const trustedRunnerPinSchema = z.object({
  kind: z.literal("trusted_runner"), runner: trustedRunnerIdSchema, hostId: z.string().min(1), revision: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), size: z.number().int().nonnegative(), mode: z.number().int().nonnegative(),
  os: z.string().min(1), architecture: z.string().min(1), versionLabel: z.string().max(240).nullable(), artifact: z.string().regex(/^[a-f0-9]{64}$/),
  machineId: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  argv: z.array(argvValueSchema).max(32),
}).strict();
export const unavailableTrustedRunnerPinSchema = z.object({
  kind: z.literal("unavailable_trusted_runner"), runner: trustedRunnerIdSchema, argv: z.array(argvValueSchema).max(32), error: z.string().min(1),
}).strict();
export const repositoryProgramPinSchema = z.object({ kind: z.literal("repository"), executable: hookPinSchema, argv: z.array(argvValueSchema).max(32) }).strict();
export const toolProgramPinSchema = z.object({ kind: z.literal("tool"), name: toolNameSchema, path: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), argv: z.array(argvValueSchema).max(32) }).strict();
export const unavailableToolProgramPinSchema = z.object({ kind: z.literal("unavailable_tool"), name: toolNameSchema, argv: z.array(argvValueSchema).max(32), error: z.string().min(1) }).strict();
// Legacy pins remain readable as history, but cannot be executed through the retired registry.
export const hookProgramPinSchema = z.discriminatedUnion("kind", [repositoryProgramPinSchema, toolProgramPinSchema, unavailableToolProgramPinSchema, trustedRunnerPinSchema, unavailableTrustedRunnerPinSchema]);
export type HookProgramPin = z.infer<typeof hookProgramPinSchema>;

/** A Queue-owned isolated execution checkout recorded before it is created. */
export const hookWorkspaceSchema = z.object({
  path: z.string().min(1),
  head: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type HookWorkspace = z.infer<typeof hookWorkspaceSchema>;

/**
 * Durable intent for one automatic exact-identity base-advance replay. It is
 * persisted on the stale occurrence before the fresh occurrence exists, so a
 * restart re-mints the same occurrence instead of spending a second advance.
 */
export const hookReplayIntentSchema = z.object({
  automatic: z.literal(true),
  ordinal: z.number().int().min(1).max(AUTOMATIC_REPLAY_LIMIT),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  at: z.string().min(1),
}).strict();
export type HookReplayIntent = z.infer<typeof hookReplayIntentSchema>;

/**
 * Immutable linkage for one merged-task retention reconciliation occurrence.
 * `taskHead` is the exact retained worktree head proven clean at mint;
 * `mergedCommit` was proven to be an ancestor of the pinned integration base.
 */
export const retentionReconciliationSchema = z.object({
  priorEventId: z.string().min(1).max(240),
  priorBaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  priorManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  taskHead: z.string().regex(/^[a-f0-9]{40}$/),
  mergedCommit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type RetentionReconciliation = z.infer<typeof retentionReconciliationSchema>;

/** Old-to-new lineage recorded on the occurrence an automatic replay minted. */
export const hookReplayLineageSchema = z.object({
  automatic: z.literal(true),
  ordinal: z.number().int().min(1).max(AUTOMATIC_REPLAY_LIMIT),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  fromEventId: z.string().min(1).max(240),
  fromOccurrence: z.number().int().min(1),
  at: z.string().min(1),
}).strict();
export type HookReplayLineage = z.infer<typeof hookReplayLineageSchema>;

export const hookEventSchema = z.object({
  schema: z.literal(EVENT_SCHEMA),
  eventId: z.string().min(1).max(240),
  hookId: hookIdSchema,
  event: hookEventNameSchema,
  occurredAt: z.string().min(1),
  attempt: z.number().int().min(1),
  repository: z.object({
    root: z.string().min(1),
    baseBranch: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  task: z.object({
    id: z.string().min(1),
    title: z.string(),
    phase: z.string(),
    instruction: instructionArtifactSchema.nullable(),
  }).strict(),
  delivery: z.object({
    prUrl: z.string().nullable(),
    prNumber: z.number().int().nullable(),
    head: z.string().nullable(),
    review: z.string().nullable(),
    mergeCommit: z.string().nullable(),
    integrationCommit: z.string().nullable(),
    summary: z.string(),
  }).strict(),
}).strict();
export type HookEvent = z.infer<typeof hookEventSchema>;
export type HookEventV2 = z.infer<typeof hookEventV2Schema>;
export type HookEventV3 = z.infer<typeof hookEventV3Schema>;
export type HookEventV4 = z.infer<typeof hookEventV4Schema>;
export type AnyHookEvent = HookEvent | HookEventV2 | HookEventV3 | HookEventV4;

/** v2 retains every v1 field and adds the closed reviewed-head target. */
export const hookEventV2Schema = hookEventSchema.extend({
  schema: z.literal(EVENT_SCHEMA_V2),
  repository: z.object({
    root: z.string().min(1),
    baseBranch: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    target: hookTargetSchema,
  }).strict(),
});

/**
 * The exact prospective merge result Queue built from the pinned integration
 * base and accepted reviewed head. `commit` is Queue's own synthetic two-parent
 * candidate; it never claims the eventual server-generated merge identity.
 */
export const mergeCandidateSchema = z.object({
  integrationBase: z.string().regex(/^[a-f0-9]{40}$/),
  reviewedHead: z.string().regex(/^[a-f0-9]{40}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type MergeCandidate = z.infer<typeof mergeCandidateSchema>;

/** v3 names the prospective-merge target and its pinned candidate identity. */
export const hookEventV3Schema = hookEventSchema.extend({
  schema: z.literal(EVENT_SCHEMA_V3),
  repository: z.object({
    root: z.string().min(1),
    baseBranch: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    target: z.literal("prospective_merge"),
    mergeCandidate: mergeCandidateSchema,
  }).strict(),
});
/**
 * v4 reconciles a merged done task's refused pre-archive retention gate at the
 * current integration base. Every v1 field is kept; the repository names the
 * merged-integration-base target and the retention linkage that proves the
 * reconciliation: the merged commit (an ancestor of the pinned base), the exact
 * retained worktree head it observed, the manifest digest at the pinned base,
 * and the refused occurrence it reconciles. The execution root stays the
 * retained worktree; the base commit is the integration base the manifest and
 * program were pinned at. Ordinary pre-archive emission keeps the frozen v1
 * payload.
 */
export const hookEventV4Schema = hookEventSchema.extend({
  schema: z.literal(EVENT_SCHEMA_V4),
  event: z.literal("task.pre_archive"),
  repository: z.object({
    root: z.string().min(1),
    baseBranch: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    target: z.literal("merged_integration_base"),
    retention: z.object({
      route: z.literal("merged_task_reconciliation"),
      mergedCommit: z.string().regex(/^[a-f0-9]{40}$/),
      taskHead: z.string().regex(/^[a-f0-9]{40}$/),
      manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      prior: z.object({
        eventId: z.string().min(1).max(240),
        baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
        manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      }).strict(),
    }).strict(),
  }).strict(),
});
export const anyHookEventSchema = z.union([hookEventSchema, hookEventV2Schema, hookEventV3Schema, hookEventV4Schema]);
const boundedSummarySchema = z.string().refine(value => utf8Length(value) >= 1 && utf8Length(value) <= SUMMARY_MAX_BYTES, `Summary must be 1-${SUMMARY_MAX_BYTES} UTF-8 bytes`);

export const hookResultSchema = z.object({
  schema: z.literal(RESULT_SCHEMA),
  eventId: z.string().min(1).max(240),
  outcome: z.enum(["ok", "blocked", "failed"]),
  summary: boundedSummarySchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
  changedPaths: z.array(repoRelativePathSchema).max(4096).default([]),
  commitSubjectSuffix: z.string().nullable().default(null),
}).strict().superRefine((result, ctx) => {
  if (!changedPathsAreSortedUnique(result.changedPaths)) ctx.addIssue({ code: "custom", path: ["changedPaths"], message: "changedPaths must be sorted and unique" });
  try { if (utf8Length(JSON.stringify(result.metadata)) > METADATA_MAX_BYTES) ctx.addIssue({ code: "custom", path: ["metadata"], message: "metadata exceeds 32 KiB" }); }
  catch { ctx.addIssue({ code: "custom", path: ["metadata"], message: "metadata is not serializable" }); }
  if (result.commitSubjectSuffix !== null && (result.outcome !== "ok" || result.changedPaths.length === 0)) ctx.addIssue({ code: "custom", path: ["commitSubjectSuffix"], message: "A commit subject suffix requires a successful integration write with changed paths" });
  if (result.commitSubjectSuffix !== null && !/^[\x20-\x7e]*$/.test(result.commitSubjectSuffix)) ctx.addIssue({ code: "custom", path: ["commitSubjectSuffix"], message: "Commit subject suffix must be printable ASCII" });
});
export type HookResult = z.infer<typeof hookResultSchema>;

const hookRecordObjectSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  hookId: hookIdSchema,
  event: hookEventNameSchema,
  eventId: z.string().min(1).max(240),
  occurrence: z.number().int().min(1),
  mode: hookModeSchema,
  delivery: hookDeliverySchema,
  state: hookStateSchema,
  manifest: hookPinSchema,
  program: hookProgramPinSchema,
  instruction: instructionArtifactSchema.nullable(),
  baseBranch: z.string().min(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  attempt: z.number().int().min(0),
  timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576),
  allowedPaths: z.array(z.string()).max(64),
  commitSubject: commitSubjectSchema.nullable(),
  eventDigest: z.string().min(1),
  // Additive internal persistence: the closed hook target and, for a
  // prospective-merge occurrence, the pinned candidate identity. Baseline
  // records parse to the integration base target with no candidate.
  target: prospectiveMergeTargetSchema.default("integration_base"),
  mergeCandidate: mergeCandidateSchema.nullable().default(null),
  // Additive internal persistence: the immutable occurrence payload plus the
  // isolated checkout this integration write owns. Baseline records carry null
  // until the deterministic generic recovery path rebuilds the delivery facts.
  eventPayload: anyHookEventSchema.nullable().default(null),
  workspace: hookWorkspaceSchema.nullable().default(null),
  // Explicit disposal intent and hold survive restart without granting execution.
  checkoutDiscard: z.object({ status: z.enum(["intent", "held"]), baseCommit: z.string().regex(/^[a-f0-9]{40}$/), at: z.string() }).optional(),
  /** A read-only occurrence superseded because the canonical base fast-forwarded to the published tip while it ran. */
  baseAdvance: z.object({ from: z.string().regex(/^[a-f0-9]{40}$/), to: z.string().regex(/^[a-f0-9]{40}$/), at: z.string() }).optional(),
  // Additive internal persistence for automatic exact-identity base-advance
  // replay: the intent recorded on the stale occurrence and the lineage on the
  // fresh one. Baseline records carry null and keep their identities.
  replayIntent: hookReplayIntentSchema.nullable().default(null),
  replay: hookReplayLineageSchema.nullable().default(null),
  // Additive internal persistence for a merged-task retention reconciliation:
  // the refused occurrence it reconciles, the exact retained worktree head it
  // observed, and the merged commit proven to be an ancestor of the pinned
  // base. The pinned integration base, manifest digest and executable digest
  // are the record's own baseCommit, manifest and program pins. Baseline
  // records carry null and keep their identities.
  retentionReconciliation: retentionReconciliationSchema.nullable().default(null),
  processId: z.number().int().nullable().default(null),
  /** The isolated process group and identity recorded for the running hook attempt. */
  processGroupId: z.number().int().positive().nullable().optional(),
  leaderStartIdentity: z.string().min(1).nullable().optional(),
  terminationSignal: z.enum(["SIGTERM", "SIGKILL"]).nullable().optional(),
  processGroupEmpty: z.boolean().nullable().optional(),
  terminationError: z.string().nullable().optional(),
  result: hookResultSchema.nullable().default(null),
  commit: z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
  remote: z.string().nullable().default(null),
  summary: z.string().default(""),
  error: z.string().default(""),
  /** The last attempt ended because the hook ran past its timeout, not because it refused or failed. */
  timedOut: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reconciledAt: z.string().nullable().default(null),
}).strict();
export const hookRecordSchema = z.preprocess(value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const { executable, argv, ...normalized } = record;
  if (record.program) return normalized;
  if (!executable) return value;
  return { ...normalized, program: { kind: "repository", executable, argv: argv ?? [] } };
}, hookRecordObjectSchema);
export type HookRecord = z.infer<typeof hookRecordSchema>;

/** Join the manifest-authored prefix with the hook-requested suffix under the byte budget. */
export function joinCommitSubject(subject: CommitSubject, suffix: string | null): string {
  const tail = suffix ?? "";
  if (/\r|\n|[\x00-\x1f\x7f]/.test(tail)) throw new Error("Commit subject suffix contains control bytes");
  const joined = subject.prefix.endsWith(" ") || !tail ? `${subject.prefix}${tail}` : `${subject.prefix} ${tail}`;
  if (utf8Length(joined) > subject.maxBytes) throw new Error("Commit subject exceeds the manifest byte budget");
  return joined;
}

export const hookEventIsAdvisory = (record: Pick<HookRecord, "delivery">) => record.delivery === "advisory";

/**
 * A merged-task retention reconciliation that the occurrence it reconciled has
 * since overtaken: that occurrence settled ok after the reconciliation did, so
 * the reconciliation no longer answers the gate or holds anything (Project-a #3686,
 * 2026-10-19: a reconciliation at the integration base demanded declarations
 * the task never had, after its own ordinary gate had passed).
 */
export function supersededRetentionReconciliation(records: Pick<HookRecord, "event" | "eventId" | "state" | "result" | "updatedAt" | "retentionReconciliation">[],
  record: Pick<HookRecord, "event" | "updatedAt" | "retentionReconciliation">): boolean {
  const priorId = record.retentionReconciliation?.priorEventId;
  if (!priorId) return false;
  const prior = records.find(item => item.event === record.event && item.eventId === priorId);
  return Boolean(prior && prior.state === "result" && prior.result?.outcome === "ok" && prior.updatedAt > record.updatedAt);
}

/** Hook outcomes that hold the triggering transition until an operator resolves them. */
export function hookHoldsTransition(record: Pick<HookRecord, "delivery" | "state" | "error">): boolean {
  if (record.state === "blocked") return true;
  if (record.state === "uncertain") return true;
  if (record.state === "failed" && record.delivery === "required") return true;
  if (record.state === "intent" && Boolean(record.error)) return true;
  return false;
}
