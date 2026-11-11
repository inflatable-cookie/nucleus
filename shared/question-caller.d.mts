export type QuestionAnswerCaller =
  | { source: "ticket"; path: string }
  | { source: "agent"; caller: string };

/** Ticket-first caller identity for `question.answer`. */
export function resolveQuestionAnswerCaller(env?: NodeJS.ProcessEnv): QuestionAnswerCaller;
