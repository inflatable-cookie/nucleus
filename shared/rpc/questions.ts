import { defineRpc } from "../rpc";
import { z } from "zod";
import { nativeQuestionIdentity, oneQuestionAgent, questionAnswerRequestSchema } from "../schema/questions";
import { hostPermissionDecisionSchema } from '../host';

export const nativeQuestionList = defineRpc({ name: "question.native-list", input: z.object(nativeQuestionIdentity).strict().refine(oneQuestionAgent, "Provide one agent identity"), output: z.array(z.object({ requestId: z.string(), questions: z.array(z.object({ header: z.string(), question: z.string(), options: z.array(z.string()) })) })) });

export const nativeQuestionAnswer = defineRpc({ name: "question.native-answer", input: z.object({ ...nativeQuestionIdentity, requestId: z.string().min(1), answers: z.record(z.string(), z.string().trim().min(1)) }).strict().refine(oneQuestionAgent, "Provide one agent identity"), output: z.object({ ok: z.literal(true) }) });

/** Owner-authenticated native primitive; every identity includes an explicit registered host. */
export const hostPermissionAnswer = defineRpc({ name: 'host.permission-answer', input: z.object({
  hostId: z.string().trim().min(1).max(500), agentId: z.string().trim().min(1).max(500),
  workspaceId: z.string().trim().min(1).max(2000), requestId: z.string().trim().min(1).max(500),
  intentId: z.string().trim().min(1).max(500), decision: hostPermissionDecisionSchema,
}).strict(), output: z.object({ ok: z.literal(true) }) });
export type HostPermissionAnswerInput = z.infer<typeof hostPermissionAnswer.input>;

export const questionAnswer = defineRpc({ name: "question.answer", input: questionAnswerRequestSchema, output: z.unknown() });
