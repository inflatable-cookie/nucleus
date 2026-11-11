import { z } from "zod";
import { laneDrainSchema, projectCloseoutSchema } from "./lanes";
import { projectValidationSchema } from "./validation";
import { projectQaSchema } from "./qa-config";
import { RETIRED_VALIDATION_POLICY_FIELD } from "./repository-identity";
import { PROJECT_OWNER_CANDIDATE_KINDS } from "../owner-candidate-kind";
import { DEFAULT_HOST_KIND, hostKindSchema } from "../host-kind";

/** The same repository identity as outcomes, lanes and task numbers: normalised origin plus a local path hint. The path hint may be empty when only the origin is known. */
export const projectRepositorySchema = z.object({
  origin: z.string().nullable(),
  path: z.string().max(1024).default(""),
}).strict();

export const projectReviewerSchema = z.object({
  login: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "Reviewer login must be a GitHub login"),
}).strict();

export type ProjectReviewer = z.infer<typeof projectReviewerSchema>;

/**
 * Task 382: one explicit per-repository hosted-check policy. `all` keeps every
 * check blocking — the behaviour every repository had before the setting — and
 * `required` makes only the checks GitHub requires for the PR's base branch
 * blocking, recording every other hosted check as advisory evidence at the
 * exact head. Required GitHub checks, branch rules and protections are never
 * weakened: Queue discovers them from the forge for the exact base and head.
 */
export const repositoryChecksPolicySchema = z.enum(["all", "required"]);

export type RepositoryChecksPolicy = z.infer<typeof repositoryChecksPolicySchema>;

export const DEFAULT_REPOSITORY_CHECKS_POLICY: RepositoryChecksPolicy = "all";

export const repositorySettingsSchema = z.object({
  repository: projectRepositorySchema,
  scratchNamespace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/).nullable().default(null),
  closeout: projectCloseoutSchema.nullable().default(null),
  validation: projectValidationSchema.nullable().default(null),
  reviewer: projectReviewerSchema.nullable().default(null),
  qa: projectQaSchema.nullable().default(null),
  // Null is the unconfigured default, so existing rows keep the blocking policy.
  checksPolicy: repositoryChecksPolicySchema.nullable().default(null),
  /** Trial host opt-in. Existing rows without the field stay on Paseo. */
  hostKind: hostKindSchema.default(DEFAULT_HOST_KIND),
  note: z.string().max(4000).default(""),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative().default(0),
}).strict();

export type RepositorySettings = z.infer<typeof repositorySettingsSchema>;

/** Origin identity outranks a path hint; a reused path cannot cross known origins. */
export function repositoryMatchSpecificity(row: Pick<RepositorySettings, "repository">, repoPath: string, origin?: string | null): 0 | 1 | 2 {
  if (origin && row.repository.origin) return row.repository.origin === origin ? 2 : 0;
  if (row.repository.path && row.repository.path === repoPath) return 1;
  return 0;
}

export const repositorySetInputSchema = z.object({
  repository: z.string().trim().min(1).max(1024),
  scratchNamespace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/).nullable().optional(),
  // Patch semantics: an absent field is untouched, an explicit null clears it.
  closeout: projectCloseoutSchema.nullable().optional(),
  validation: projectValidationSchema.nullable().optional(),
  reviewer: projectReviewerSchema.nullable().optional(),
  qa: projectQaSchema.nullable().optional(),
  // Parsed only so the refusal below names the replacement; no stored row keeps it.
  [RETIRED_VALIDATION_POLICY_FIELD]: z.unknown().optional(),
  checksPolicy: repositoryChecksPolicySchema.nullable().optional(),
  hostKind: hostKindSchema.optional(),
  note: z.string().max(4000).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.validationPolicy !== undefined) ctx.addIssue({ code: "custom", path: ["validationPolicy"],
    message: "validationPolicy is no longer available; put it in the repository's AGENTS.md Validate section" });
});

export type RepositorySetInput = z.input<typeof repositorySetInputSchema>;

export const repositoryQuerySchema = z.object({ repository: z.string().trim().min(1).max(1024) }).strict();

/** Spec 042: the thread that owns a project's project-level prompts. `assignedBy` is "operator" or the claiming agent's id. */
export const projectOwnerSchema = z.object({
  agentId: z.string().trim().min(1).max(300),
  assignedBy: z.string().trim().min(1).max(300),
  assignedAt: z.string(),
  note: z.string().max(4000).default(""),
}).strict();

export type ProjectOwner = z.infer<typeof projectOwnerSchema>;

export const projectSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(200),
  version: z.number().int().positive().default(1),
  visibility: z.enum(["active", "parked"]).default("active"),
  repositories: z.array(projectRepositorySchema.refine(repo => Boolean(repo.origin || repo.path), "Repository needs an origin or path")).min(1),
  primary: projectRepositorySchema,
  // Spec 041: the open next-aim episode while the project's board is drained; operational, re-forms from activity.
  drain: laneDrainSchema.nullable().default(null),
  // Spec 042, retired 2026-11-02 (Spec 058 cutover 5): the owner role is gone. The field stays on
  // old rows — and on projects the one-time migration converted — as readable history; nothing routes by it.
  owner: projectOwnerSchema.nullable().optional(),
  ownerMissingAt: z.string().nullable().optional(),
  ownerCheckedAt: z.string().nullable().optional(),
  // Spec 058 (task 540): the planner thread that answers this project's delegated questions. It grants nothing else.
  planner: z.object({ agentId: z.string().trim().min(1).max(300), setBy: z.string().trim().min(1).max(300), setAt: z.string(), }).strict().nullable().optional(),
}).strict().refine(project => project.repositories.some(repo =>
  repo.origin && project.primary.origin ? repo.origin === project.primary.origin : Boolean(repo.path && repo.path === project.primary.path)),
  "Primary repository must belong to the project");

export type Project = z.infer<typeof projectSchema>;

/** Spec 042, re-derived for the planner (Spec 058 cutover 5): a project is silent when no planner thread and no live owner record stands behind it. */
export const projectDormant = (project: Pick<Project, "owner" | "ownerMissingAt" | "planner">): boolean =>
  !project.planner?.agentId && (!project.owner || Boolean(project.ownerMissingAt));

/**
 * Spec 027: removing a project record writes a permanent tombstone so an export
 * or import never resurrects it, mirroring the submission tombstones (Spec 029).
 */
export const projectTombstoneSchema = z.object({
  key: projectSchema.shape.key,
  repositories: projectSchema.shape.repositories,
  reason: z.string().trim().min(1).max(4000),
  removedAt: z.string(),
}).strict();

export type ProjectTombstone = z.infer<typeof projectTombstoneSchema>;

/**
 * Spec 027: one reason a project cannot be removed. The board's confirmation and
 * the removal refusal read the same list from Queue, never a recomputed view.
 */
export const projectRemovalBlockerKindSchema = z.enum(["task", "lead", "papercut", "decision", "lane", "submission", "operation", "qa"]);

export const projectRemovalBlockerSchema = z.object({
  kind: projectRemovalBlockerKindSchema,
  label: z.string().min(1),
  names: z.array(z.string()),
}).strict();

export type ProjectRemovalBlocker = z.infer<typeof projectRemovalBlockerSchema>;

export type ProjectRemovalBlockerKind = z.infer<typeof projectRemovalBlockerKindSchema>;

export const projectUpsertInputSchema = z.object({
  key: projectSchema.shape.key,
  name: projectSchema.shape.name,
  repositories: projectSchema.shape.repositories,
  primary: projectRepositorySchema.optional(),
  /**
   * Create only (Settings → Add project, nucleus#949): refused when a project with this
   * key exists, checked in the store's write transaction, so a client choosing a key from
   * a stale list can never update another project. Omitted, the call is an upsert.
   */
  create: z.literal(true).optional(),
}).strict()
  .refine(project => project.repositories.length === 1 || Boolean(project.primary),
    "Primary repository is required for a project with several repositories");

export type ProjectUpsertInput = z.infer<typeof projectUpsertInputSchema>;

export const projectVisibilityInputSchema = z.object({ key: projectSchema.shape.key, version: z.number().int().positive() }).strict();

export const projectQuerySchema = z.union([
  z.object({ key: z.string().min(1) }).strict(),
  // Last so the typed input resolves a project by repository; the legacy string
  // form below is still accepted at runtime and refused with a migration pointer
  // by the handler.
  z.object({ repository: projectRepositorySchema }).strict(),
  z.object({ repository: z.string().min(1) }).strict(),
]);

/** Spec 058 (task 540): the operator or the planner thread itself names the project's planner; null clears it. */
export const projectSetPlannerInputSchema = z.object({
  key: projectSchema.shape.key,
  agentId: z.string().trim().min(1).max(300).nullable(),
  /** The calling thread; the CLI fills it from PASEO_AGENT_ID, and the board fills the operator. */
  setBy: z.string().trim().min(1).max(300).default("operator"),
  /** Optional reason, recorded beside the change in the project's event history. */
  note: z.string().trim().max(2000).optional(),
}).strict();

export const projectOwnerCandidateKindSchema = z.enum(PROJECT_OWNER_CANDIDATE_KINDS);

export const projectOwnerCandidateSchema = z.object({
  id: z.string(), title: z.string(), workspaceId: z.string().nullable(),
  kind: projectOwnerCandidateKindSchema,
}).strict();
