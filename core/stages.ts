import { isAbsolute } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { owningDocumentPathsSchema } from "../shared/contracts";

/**
 * Spec 043 (c): the declared review-stage declaration reader.
 *
 * Declared-stage execution was retired on 2026-10-06 (Tom; `retired.toml`,
 * `declared-step-execution`) and its engine code was removed on 2026-10-13.
 * This module keeps only what history needs: the schema that validates a
 * brief's `queue.stages`/`queue.subjectSets`/`queue.goal` frontmatter, so new
 * declarations are still refused precisely and historical declarations stay
 * parseable, plus the read-only `stageDeclarationFromBrief` view the
 * retired-step guards use to park an unfinished staged task until its owner
 * amends it to a plain completion brief. It executes nothing.
 */

const stageIdSchema = z.string().trim().min(1).max(120);
const normalizedStagePath = (path: string) =>
  !isAbsolute(path) && !path.includes("\\") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
const stagePathSchema = z.string().trim().min(1).max(4096).refine(normalizedStagePath,
  "Path must be a normalized repository-relative path");
export const stageSubjectSchema = z.object({
  head: z.literal("candidate"),
  digests: z.array(z.object({ path: stagePathSchema }).strict()),
}).strict().superRefine((subject, ctx) => {
  const seen = new Set<string>();
  subject.digests.forEach((digest, index) => {
    if (seen.has(digest.path)) ctx.addIssue({ code: "custom", path: ["digests", index, "path"], message: "Subject digest paths must be unique" });
    seen.add(digest.path);
  });
});
const stageGateSchema = z.object({
  pass: z.array(z.string().trim().min(1).max(120)),
  insufficient: z.array(z.string().trim().min(1).max(120)),
}).strict().superRefine((gate, ctx) => {
  const pass = new Set<string>();
  gate.pass.forEach((id, index) => {
    if (pass.has(id)) ctx.addIssue({ code: "custom", path: ["pass", index], message: "Gate verdict ids must be unique" });
    pass.add(id);
  });
  const insufficient = new Set<string>();
  gate.insufficient.forEach((id, index) => {
    if (insufficient.has(id)) ctx.addIssue({ code: "custom", path: ["insufficient", index], message: "Gate verdict ids must be unique" });
    if (pass.has(id)) ctx.addIssue({ code: "custom", path: ["insufficient", index], message: "A verdict id cannot be both required to pass and permitted insufficient" });
    insufficient.add(id);
  });
});
const stageActionSchema = z.union([
  z.literal("push"), z.literal("comment"),
  z.object({ publish: z.string().trim().min(1).max(240) }).strict(),
]);
/**
 * Spec 043 declared publish outputs. Only a `work` or `publish` stage may name
 * repository-relative paths or path prefixes its own run is authorised to
 * change; a frozen digest change confined to them does not invalidate earlier
 * stages. A prefix covers every path beneath it.
 */
const stageOutputsSchema = z.array(stagePathSchema).superRefine((outputs, ctx) => {
  const seen = new Set<string>();
  outputs.forEach((output, index) => {
    if (seen.has(output)) ctx.addIssue({ code: "custom", path: [index], message: "Declared stage outputs must be unique" });
    seen.add(output);
  });
});
const stageWaitSchema = z.object({
  kind: z.enum(["operator", "source_rights"]),
  name: z.string().trim().min(1).max(400),
}).strict();
/**
 * Spec 043 stage profile. A review or verify stage may route itself to one named
 * reviewer profile, preflighted like a `route` reviewer request: the
 * profile must exist, carry the reviewer role, be in an available subscription
 * group, name an explicit reason and not be an opaque provider-default model.
 */
const stageProfileSchema = z.object({
  id: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(4000),
}).strict();
const stageEvidenceSchema = z.object({
  pins: z.array(z.object({ name: z.string().trim().min(1).max(240), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1, "Evidence must include at least one pin"),
  maxRuns: z.literal(1),
}).strict().superRefine((evidence, ctx) => {
  const seen = new Set<string>();
  evidence.pins.forEach((pin, index) => {
    if (seen.has(pin.name)) ctx.addIssue({ code: "custom", path: ["pins", index, "name"], message: "Evidence pin names must be unique" });
    seen.add(pin.name);
  });
});
export const stageDefinitionSchema = z.object({
  id: stageIdSchema,
  kind: z.enum(["work", "review", "verify", "publish"]),
  subject: stageSubjectSchema,
  role: z.string().trim().min(1).max(120),
  independence: z.array(stageIdSchema),
  gate: stageGateSchema,
  actions: z.array(stageActionSchema).min(1, "A stage must permit at least one action"),
  outputs: stageOutputsSchema.optional(),
  preservedOwningDocuments: owningDocumentPathsSchema.optional(),
  profile: stageProfileSchema.optional(),
  evidence: stageEvidenceSchema.optional(),
  wait: z.array(stageWaitSchema),
}).strict().superRefine((stage, ctx) => {
  if (stage.profile && stage.kind !== "review" && stage.kind !== "verify")
    ctx.addIssue({ code: "custom", path: ["profile"], message: "Only a review or verify stage may name a profile" });
  if (stage.outputs && stage.kind !== "work" && stage.kind !== "publish")
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "Only a work or publish stage may declare authorised outputs" });
  if (stage.preservedOwningDocuments && stage.kind !== 'work' && stage.kind !== 'publish')
    ctx.addIssue({ code: 'custom', path: ['preservedOwningDocuments'], message: 'Only an authoring stage may declare preserved owning documents' });
  const references = new Set<string>();
  stage.independence.forEach((id, index) => {
    if (references.has(id)) ctx.addIssue({ code: "custom", path: ["independence", index], message: "Independence stage ids must be unique" });
    references.add(id);
  });
});
export const stageListSchema = z.array(stageDefinitionSchema).min(1).superRefine((stages, ctx) => {
  const ids = new Set<string>();
  stages.forEach((stage, index) => {
    if (ids.has(stage.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Stage ids must be unique" });
    ids.add(stage.id);
    stage.independence.forEach((reference, referenceIndex) => {
      if (!stages.slice(0, index).some(earlier => earlier.id === reference))
        ctx.addIssue({ code: "custom", path: [index, "independence", referenceIndex], message: "Independence may reference only earlier stages" });
    });
  });
  if (new Set(stages.flatMap(stage => stage.preservedOwningDocuments ?? [])).size > 8)
    ctx.addIssue({ code: 'custom', message: 'A stage plan may preserve at most eight exact owning documents' });
  const terminal = stages.at(-1);
  if (terminal && terminal.kind !== "review" && terminal.kind !== "verify")
    ctx.addIssue({ code: "custom", path: [stages.length - 1, "kind"], message: "The last stage must be review or verify" });
});
/**
 * Spec 043 goal gate. `queue.goal` is a list of named verdict ids, or `true` for
 * the terminal stage's own gate. The declaration is only meaningful with stages,
 * and the brief schema refuses a goal without them.
 */
export const stageGoalSchema = z.union([
  z.literal(true),
  z.array(z.string().trim().min(1).max(120)).min(1),
]);

/** Versioned, explicit reuse only: sets contain inline subjects, never references. */
const subjectSetNameSchema = z.string().min(1).max(120).refine(name => name === name.trim(), 'Subject set names must not contain leading or trailing whitespace');
export const stageSubjectSetsSchema = z.object({
  version: z.literal(1),
  sets: z.record(subjectSetNameSchema, stageSubjectSchema),
}).strict();
const stageSubjectReferenceSchema = z.object({
  ref: subjectSetNameSchema,
  // Additions are explicit. Replacing or deleting a shared path is not an override.
  addDigests: z.array(z.object({ path: stagePathSchema }).strict()).optional(),
}).strict();
const stageSubjectInputSchema = z.unknown().transform((value, ctx): z.infer<typeof stageSubjectSchema> | z.infer<typeof stageSubjectReferenceSchema> => {
  // Select by the explicit reference key so malformed inline subjects retain
  // their existing precise field errors, rather than a generic union refusal.
  const schema = value !== null && typeof value === 'object' && Object.hasOwn(value, 'ref')
    ? stageSubjectReferenceSchema : stageSubjectSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  return parsed.data;
});
export const stageDefinitionInputSchema = z.object({
  ...stageDefinitionSchema.shape,
  subject: stageSubjectInputSchema,
}).strict();

/**
 * Both brief admission and runtime reading use this compiler. Only the resolved
 * inline definitions reach gates, prompts, hashes or plan comparison. Set names
 * and representation cannot change a resolved plan's identity or authority.
 */
export const stageDeclarationSchema = z.object({
  stages: z.array(stageDefinitionInputSchema).min(1),
  subjectSets: stageSubjectSetsSchema.optional(),
  goal: stageGoalSchema.optional(),
}).strict().transform((declaration, ctx) => {
  const stages = declaration.stages.map((stage, index) => {
    if (!('ref' in stage.subject)) return stage;
    const sets = declaration.subjectSets?.sets;
    const shared = sets && Object.hasOwn(sets, stage.subject.ref) ? sets[stage.subject.ref] : undefined;
    if (!shared) {
      ctx.addIssue({ code: 'custom', path: ['stages', index, 'subject', 'ref'], message: `Unknown subject set: ${stage.subject.ref}` });
      return stage;
    }
    return { ...stage, subject: { head: shared.head, digests: [...shared.digests, ...(stage.subject.addDigests ?? [])] } };
  });
  const parsed = stageListSchema.safeParse(stages);
  if (!parsed.success) {
    // A missing reference already has its precise error above, rather than a
    // second error complaining that the unresolved reference is not inline.
    for (const issue of parsed.error.issues) {
      const index = issue.path[0];
      if (typeof index === 'number' && 'ref' in stages[index].subject && issue.path[1] === 'subject') continue;
      ctx.addIssue({ ...issue, path: ['stages', ...issue.path] });
    }
    return z.NEVER;
  }
  return freezeStageValue({ stages: parsed.data, goal: declaration.goal ?? null });
});

/** Compiled declarations are immutable, so the cache cannot drift. */
function freezeStageValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeStageValue(child);
    Object.freeze(value);
  }
  return value;
}
const declarationCache = new Map<string, StageDeclaration>();

export type StageKind = z.infer<typeof stageDefinitionSchema>["kind"];
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
export type StageGoal = z.infer<typeof stageGoalSchema>;
export interface StageDeclaration {
  stages: StageDefinition[];
  goal: StageGoal | null;
}

/**
 * Read the declared plan from a Queue-held brief's text. This is a read-only view
 * of frontmatter step (b) already validated; an unparseable or legacy brief simply
 * has no stages, exactly as before. It never throws into the engine.
 */
export function stageDeclarationFromBrief(briefText: string): StageDeclaration | null {
  const cached = declarationCache.get(briefText);
  if (cached) return cached;
  const match = briefText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  let queue: unknown;
  try {
    const doc = parseDocument(match[1]);
    if (doc.errors.length) return null;
    const front = doc.toJS({ maxAliasCount: 0 }) as { queue?: unknown } | null;
    queue = front?.queue;
  } catch {
    return null;
  }
  if (!queue || typeof queue !== "object") return null;
  const stages = (queue as { stages?: unknown }).stages;
  if (stages === undefined) return null;
  const fields = queue as { stages?: unknown; subjectSets?: unknown; goal?: unknown };
  const parsed = stageDeclarationSchema.safeParse({ stages, subjectSets: fields.subjectSets, goal: fields.goal ?? undefined });
  if (!parsed.success) return null;
  if (declarationCache.size >= 64) declarationCache.delete(declarationCache.keys().next().value!);
  declarationCache.set(briefText, parsed.data);
  return parsed.data;
}
