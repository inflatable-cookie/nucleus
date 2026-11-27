import { defineRpc } from "../rpc";
import { ownerInventoryInputSchema, ownerInventorySchema, projectManageInputSchema, projectManagementPreviewSchema, projectMergeCheckInputSchema, projectMergeCheckSchema, projectMergeInputSchema, projectMergeOutputSchema, projectRemovalBlockersInputSchema, projectRemoveInputSchema, projectRemoveRepositoryInputSchema, reparentInputSchema, reparentResultSchema } from "../schema/project-management";
import { z } from "zod";
import { projectRemovalBlockerSchema, projectSchema, projectTombstoneSchema } from "../schema/projects";

export const reparent = defineRpc({ name: "queue.reparent", input: reparentInputSchema, output: reparentResultSchema });

export const ownerInventory = defineRpc({ name: "queue.owner-inventory", input: ownerInventoryInputSchema, output: ownerInventorySchema });

export const projectManagementPreview = defineRpc({ name: "project.management-preview", input: z.object({ key: projectSchema.shape.key, target: projectSchema.shape.key.optional() }).strict(), output: projectManagementPreviewSchema });

export const projectManage = defineRpc({ name: "project.manage-remove", input: projectManageInputSchema, output: projectTombstoneSchema });

export const projectRemove = defineRpc({ name: "project.remove", input: projectRemoveInputSchema, output: projectTombstoneSchema });

export const projectRemovalBlockers = defineRpc({ name: "project.removal-blockers", input: projectRemovalBlockersInputSchema, output: z.array(projectRemovalBlockerSchema) });

export const projectRemoveRepository = defineRpc({ name: "project.remove-repository", input: projectRemoveRepositoryInputSchema,
  output: z.object({ project: projectSchema, tombstone: projectTombstoneSchema }).strict() });

export const projectMerge = defineRpc({ name: "project.merge", input: projectMergeInputSchema, output: projectMergeOutputSchema });

export const projectMergeCheck = defineRpc({ name: "project.merge-check", input: projectMergeCheckInputSchema, output: projectMergeCheckSchema });
