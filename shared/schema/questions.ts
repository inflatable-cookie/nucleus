import { z } from "zod";
import { identitySourceSchema } from "../host-kind";
import { explicitCommandSchema, type ExplicitCommand } from "./task-control";

/** Spec 058 & Spec 067: a delegated answer is a command from the recipient's calling thread. */
const questionAnswerFields = {
  questionId: z.string().trim().min(1).max(300),
  caller: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(4000).optional(),
  choice: z.string().trim().min(1).max(400).optional(),
  command: explicitCommandSchema.optional(),
  version: z.number().int().positive().optional(),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^[^\r\n]*$/),
  overtakes: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  decision: z.literal("operator").optional(),
  dryRun: z.boolean().optional(),
};
const answerShape = <
  T extends {
    answer?: string;
    choice?: string;
    decision?: string;
    command?: ExplicitCommand;
  },
>(
  value: T,
) =>
  Number(Boolean(value.answer)) +
    Number(Boolean(value.choice)) +
    Number(Boolean(value.decision)) +
    Number(Boolean(value.command)) ===
  1;
const commandVersionValid = <
  T extends { version?: number; command?: ExplicitCommand },
>(
  value: T,
) =>
  !value.command ||
  (value.version !== undefined || value.command.version !== undefined);
const commandVersionsMatch = <
  T extends { version?: number; command?: ExplicitCommand },
>(
  value: T,
) =>
  value.version === undefined ||
  value.command?.version === undefined ||
  value.version === value.command.version;
export const questionAnswerInputSchema = z
  .object(questionAnswerFields)
  .strict()
  .refine(answerShape, {
    message: "Provide exactly one of answer, choice, decision or command",
  })
  .refine(commandVersionValid, {
    path: ["version"],
    message: "A command answer requires a task version",
  })
  .refine(commandVersionsMatch, {
    path: ["version"],
    message: "version and command.version must match",
  });

export const questionAnswerRequestSchema = z
  .object({
    ...questionAnswerFields,
    questionId: questionAnswerFields.questionId.optional(),
    taskId: z.string().trim().min(1).max(200).optional(),
    reference: z.string().trim().min(1).max(200).optional(),
    /** The answering thread's own identity source, filled by the CLI from its environment. */
    identitySource: identitySourceSchema.optional(),
  })
  .strict()
  .refine(answerShape, {
    message: "Provide exactly one of answer, choice, decision or command",
  })
  .refine(commandVersionValid, {
    path: ["version"],
    message: "A command answer requires a task version",
  })
  .refine(commandVersionsMatch, {
    path: ["version"],
    message: "version and command.version must match",
  })
  .refine(
    (value) =>
      [value.questionId, value.taskId, value.reference].filter(
        (value) => value !== undefined,
      ).length === 1,
    {
      path: ["questionId"],
      message: "Pass exactly one of questionId, taskId or reference",
    },
  );
export type QuestionAnswerRequest = z.infer<typeof questionAnswerRequestSchema>;

export type QuestionAnswerInput = z.infer<typeof questionAnswerInputSchema>;

/** Live native questions on a task's retained worker or reviewer. */
export const nativeQuestionIdentity = {
  taskId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentRef: z.string().min(1).optional(),
};

export const oneQuestionAgent = (input: {
  agentId?: string;
  agentRef?: string;
}) => Boolean(input.agentId) !== Boolean(input.agentRef);
