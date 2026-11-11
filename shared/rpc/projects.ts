import { defineRpc } from "../rpc";
import { projectOwnerCandidateSchema, projectQuerySchema, projectSchema, projectSetPlannerInputSchema, projectUpsertInputSchema, projectVisibilityInputSchema, repositoryQuerySchema, repositorySetInputSchema, repositorySettingsSchema } from "../schema/projects";
import { z } from "zod";
import { repositoryRekeyInputSchema, repositoryRekeyOutputSchema, repositoryRekeyPreviewInputSchema, repositoryRekeyPreviewSchema, repositoryRekeyReceiptQuerySchema, repositoryRekeyReceiptSchema } from "../repository-rekey";

export const repositorySet = defineRpc({ name: "repository.set", input: repositorySetInputSchema, output: repositorySettingsSchema });

export const repositoryGet = defineRpc({ name: "repository.get", input: repositoryQuerySchema, output: repositorySettingsSchema.nullable() });

export const repositories = defineRpc({ name: "repositories", input: z.object({}).strict(), output: z.array(repositorySettingsSchema) });

/**
 * Spec 056: one operator-invoked repository namespace re-key. The preview reads
 * what a fresh apply would do and is never authority to apply drifted input;
 * the apply runs as the durable `repository_rekey` operation and returns its
 * durable receipt. No checkout, Git remote or forge repository is touched.
 */
export const repositoryRekeyPreview = defineRpc({ name: "repository.rekey-preview", input: repositoryRekeyPreviewInputSchema, output: repositoryRekeyPreviewSchema });

export const repositoryRekey = defineRpc({ name: "repository.rekey", input: repositoryRekeyInputSchema, output: repositoryRekeyOutputSchema });

export const repositoryRekeyReceiptRead = defineRpc({ name: "repository.rekey-receipt", input: repositoryRekeyReceiptQuerySchema, output: repositoryRekeyReceiptSchema.nullable() });

export const projectUpsert = defineRpc({ name: "project.upsert", input: projectUpsertInputSchema, output: projectSchema });

export const projectPark = defineRpc({ name: "project.park", input: projectVisibilityInputSchema, output: projectSchema });

export const projectUnpark = defineRpc({ name: "project.unpark", input: projectVisibilityInputSchema, output: projectSchema });

/**
 * The assignment response, carrying the participant identity ticket when the
 * calling thread named itself as its project's planner.
 */
export const projectSetPlanner = defineRpc({ name: "project.set-planner", input: projectSetPlannerInputSchema, output: projectSchema.extend({ participantTicket: z.string().min(1).optional() }) });

export const projectOwnerCandidates = defineRpc({ name: "project.owner-candidates", input: z.object({}).strict(), output: z.array(projectOwnerCandidateSchema) });

export const projectGet = defineRpc({ name: "project.get", input: projectQuerySchema, output: projectSchema.nullable() });

export const projects = defineRpc({ name: "projects", input: z.object({}).strict(), output: z.array(projectSchema) });
