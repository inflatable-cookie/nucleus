import { z } from "zod";
import {
  buildOutputCleanupSchema,
  displacedHostWorkspaceSchema,
  externalWorkspaceArchiveSchema,
  runtimeRetirementSchema,
  workspaceArchiveRetrySchema,
} from "./workspace";

/**
 * The workspace a terminal task leaves behind: its cancellation or closeout cleanup
 * authority, archive intents and the retirement records, each keyed to one workspace.
 */
export const resolutionWorkspaceFields = {
  // Later cleanup authority is separate from the completed cancellation disposition.
  workspaceRetirement: z
    .object({
      workspaceId: z.string(),
      directory: z.string(),
      branch: z.string(),
      head: z.string().nullable(),
      authorization: z
        .object({
          caller: z.string(),
          kind: z.enum(["project_owner", "operator", "relayed_note"]),
          note: z.string().nullable(),
          reason: z.string(),
          at: z.string(),
        })
        .strict(),
      state: z.enum(["authorized", "held", "intent", "uncertain", "archived"]),
      detail: z.string(),
      intentAt: z.string().nullable(),
      archivedAt: z.string().nullable(),
    })
    .strict()
    .nullable()
    .default(null),
  closeoutWorkspaceIntent: z.boolean().default(false),
  closeoutWorkspaceId: z.string().nullable().default(null),
  closeoutDirectory: z.string().nullable().default(null),
  closeoutWorkspaceHead: z.string().nullable().default(null),
  archivedWorkspaceIds: z.array(z.string()).default([]),
  archiveIntentWorkspaceId: z.string().nullable().default(null),
  // The exact source head the archive intent bound; an uncertain retry never rederives it.
  archiveIntentHead: z.string().nullable().default(null),
  cleanupReason: z.string().default(""),
  buildOutputCleanups: z.array(buildOutputCleanupSchema).default([]),
  workspaceArchiveRetries: z.array(workspaceArchiveRetrySchema).default([]),
  runtimeRetirements: z.array(runtimeRetirementSchema).default([]),
  // Spec 017: preserved external workspaces whose Paseo sidebar entry is archived
  // while their folder is kept. Never an archive of the workspace's files.
  externalWorkspaceArchives: z
    .array(externalWorkspaceArchiveSchema)
    .default([]),
  displacedHostWorkspaces: z.array(displacedHostWorkspaceSchema).default([]),
};
