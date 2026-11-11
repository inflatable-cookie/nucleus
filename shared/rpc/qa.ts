import { defineRpc } from "../rpc";
import { z } from "zod";
import { projectQaCancelInputSchema, projectQaDismissInputSchema, projectQaFenceInputSchema, projectQaGetInputSchema, projectQaRequestSchema, projectQaRequestStatusInputSchema, projectQaRetryTeardownInputSchema, projectQaRunInputSchema, projectQaRunSchema } from "../schema/qa";
import { qaFenceStatusSchema } from "../schema/qa-fence";

export const projectQaRequestStatus = defineRpc({ name: "project.qa.request-status", input: projectQaRequestStatusInputSchema,
  output: z.object({ ownerInstance: z.string().uuid(), ownerPid: z.number().int().positive(),
    requests: z.array(projectQaRequestSchema), runs: z.array(projectQaRunSchema) }).strict() });

export const projectQaRun = defineRpc({ name: "project.qa.run", input: projectQaRunInputSchema, output: projectQaRunSchema });

export const projectQaCancel = defineRpc({ name: "project.qa.cancel", input: projectQaCancelInputSchema, output: projectQaRunSchema });

export const projectQaDismiss = defineRpc({ name: "project.qa.dismiss", input: projectQaDismissInputSchema, output: projectQaRunSchema });

export const projectQaRetryTeardown = defineRpc({ name: "project.qa.retry-teardown", input: projectQaRetryTeardownInputSchema, output: projectQaRunSchema });

export const projectQaGet = defineRpc({ name: "project.qa.get", input: projectQaGetInputSchema, output: projectQaRunSchema.nullable() });

export const projectQaList = defineRpc({ name: "project.qa.list", input: z.object({}).strict(), output: z.array(projectQaRunSchema) });

export const projectQaFence = defineRpc({ name: "project.qa.fence", input: projectQaFenceInputSchema, output: qaFenceStatusSchema });

export const projectQaFenceStatus = defineRpc({ name: "project.qa.fence-status", input: z.object({}).strict(), output: qaFenceStatusSchema });
