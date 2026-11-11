import { defineRpc } from "../rpc";
import { z } from "zod";
import { nativeQuestionIdentity, oneQuestionAgent, questionAnswerRequestSchema } from "../schema/questions";

export const nativeQuestionList = defineRpc({ name: "question.native-list", input: z.object(nativeQuestionIdentity).strict().refine(oneQuestionAgent, "Provide one agent identity"), output: z.array(z.object({ requestId: z.string(), questions: z.array(z.object({ header: z.string(), question: z.string(), options: z.array(z.string()) })) })) });

export const nativeQuestionAnswer = defineRpc({ name: "question.native-answer", input: z.object({ ...nativeQuestionIdentity, requestId: z.string().min(1), answers: z.record(z.string(), z.string().trim().min(1)) }).strict().refine(oneQuestionAgent, "Provide one agent identity"), output: z.object({ ok: z.literal(true) }) });

export const questionAnswer = defineRpc({ name: "question.answer", input: questionAnswerRequestSchema, output: z.unknown() });
