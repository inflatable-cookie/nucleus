import { defineRpc } from "../rpc";
import { z } from "zod";
import { projectQaGetInputSchema, projectQaRequestSchema, projectQaRequestStatusInputSchema, projectQaRunInputSchema, projectQaRunSchema } from "../schema/qa";

export const projectQaRequestStatus = defineRpc({ name: "project.qa.request-status", input: projectQaRequestStatusInputSchema,
  output: z.object({ ownerInstance: z.string().uuid(), ownerPid: z.number().int().positive(),
    requests: z.array(projectQaRequestSchema), runs: z.array(projectQaRunSchema) }).strict() });

export const projectQaRun = defineRpc({ name: "project.qa.run", input: projectQaRunInputSchema, output: projectQaRunSchema });




export const projectQaGet = defineRpc({ name: "project.qa.get", input: projectQaGetInputSchema, output: projectQaRunSchema.nullable() });

export const projectQaList = defineRpc({ name: "project.qa.list", input: z.object({}).strict(), output: z.array(projectQaRunSchema) });
